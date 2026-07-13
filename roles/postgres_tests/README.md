# Postgres HA — Test Suite

Pre-production validation suite for the Postgres/Patroni/etcd HA cluster,
structured the same way as the Nexus test suite shared as a reference: one
playbook, one role, each test category in its own task file, gated by an
enable flag + tag, safe tests ON by default, disruptive/destructive ones OFF.

**Status: safe suite (functional, security, monitoring, load) verified
passing end-to-end on 2026-07-13.** See "Last verified run" below.

## Why not pure k6 for everything

k6's open-source build speaks HTTP, not the raw Postgres wire protocol
(that requires a custom `xk6-sql` build, which most environments don't
have). So load testing here uses two tools, each for what it's actually
good at:

- **pgbench** — real database throughput (the number that actually matters:
  transactions/sec against the Leader over SSL)
- **k6** — the HTTP-facing surface: Patroni's REST API, which is exactly
  what HAProxy health checks and Prometheus/monitoring poll continuously
  in production.

## Structure

```
postgres_tests/
├── tests.yml                      # top-level playbook
├── defaults/main.yml               # every enable flag + threshold
├── tasks/
│   ├── main.yml                    # dispatcher — also resolves the CURRENT
│   │                                # leader once, before any category runs
│   ├── functional.yml              # connectivity, leader uniqueness, replication proof
│   ├── security.yml                # hostssl, wrong-password, listen_addresses, pgAudit, watchdog mode
│   ├── monitoring.yml              # Patroni state, etcd health, replication lag
│   ├── load.yml                    # pgbench + k6 against Patroni REST API
│   ├── ha.yml                      # DISRUPTIVE: real switchover, confirms clean recovery
│   ├── etcd_resilience.yml         # DISRUPTIVE: stops 1 etcd node, confirms zero impact
│   ├── watchdog.yml                # DISRUPTIVE: confirms watchdog fd is armed on leader
│   └── disaster_recovery.yml       # SCAFFOLD ONLY — blocked until pgBackRest is deployed
└── files/
    └── k6_patroni_api_test.js      # k6 script, mixed /health, /patroni, /leader workload
```

## Summary matrix

| # | Category | Tag | Default | Risk | Hard asserts |
|---|---|---|---|---|---|
| 1 | Functional | `functional` | ON | None | Single leader, SELECT 1, replication propagates a marker row |
| 2 | Security | `security` | ON | None | hostssl enforced, wrong password rejected, listen_addresses restricted, pgAudit loaded, watchdog mode=required, no plain `host` rules |
| 3 | Monitoring | `monitoring` | ON | None | All nodes `running`, all etcd endpoints healthy, replicas within lag budget |
| 4 | Load (pgbench + k6) | `load` | ON | Low | TPS above threshold, k6 p95<500ms, error rate<5% |
| 5 | HA / switchover | `ha` | **OFF** | **Disruptive** (~1-3s write pause) | Intended candidate promoted, old leader rejoins clean |
| 6 | etcd resilience | `etcd_resilience` | **OFF** | **Disruptive** (stops a real etcd node) | Cluster unaffected losing 1-of-3, full quorum restored after |
| 7 | Watchdog | `watchdog` | **OFF** | **Disruptive** (uses ha.yml's switchover if forcing promotion) | Leader holds an open watchdog fd |
| 8 | Disaster Recovery | `dr` | **OFF** | **Blocked** | Scaffold only — refuses to run until pgBackRest exists |

## Last verified run — 2026-07-13

Full safe suite (`functional`, `security`, `monitoring`, `load`), no tags,
against the live 2-node cluster (vm1/vm2) + 3-node etcd (vm1/vm2/vm7):

```
PLAY RECAP
vm1 : ok=55  changed=8  unreachable=0  failed=0  skipped=4  rescued=0  ignored=0
```

| Metric | Result | Threshold |
|---|---|---|
| Leader count | 1 | exactly 1 |
| Replication lag | 0 bytes | < 16 MB |
| etcd nodes healthy | 3/3 | 3/3 |
| pgbench TPS | 253–297 (varies per run) | ≥ 50 |
| k6 p95 latency (Patroni API) | 16–25 ms | < 500 ms |
| k6 error rate | 0% | < 5% |
| Non-SSL connection | correctly rejected | must reject |
| Wrong password | correctly rejected | must reject |

`skipped=4` is expected — that's the four disruptive/destructive categories
(`ha`, `etcd_resilience`, `watchdog`, `dr`), which stay off by default.

## Bugs found and fixed during the first real run

Worth keeping here since they're non-obvious and would bite anyone reusing
this suite:

1. **Hardcoded first node ≠ actual leader.** `functional.yml` and `load.yml`
   originally wrote to `pg_test_nodes[0].host` (always vm1), which failed
   with `cannot execute CREATE TABLE in a read-only transaction` whenever
   vm2 was leader. Fixed by resolving the real leader once in
   `tasks/main.yml` via Patroni's `/cluster` endpoint, exposed as
   `pg_test_leader_host` for every subsequent task.

2. **k6 under snap confinement can't see `/tmp`.** `snap connections k6`
   only grants a `home` plug — no `/tmp` access — so the script and the
   summary JSON must live under `$HOME`, not `/tmp`. Fixed by switching
   every path to `lookup('env','HOME')` (not `ansible_env.HOME`, which
   resolves to the **remote** host's home — `/root`, given
   `remote_user = root` — not the control node's).

3. **k6's summary JSON threshold format.** `metrics.<name>.thresholds` is a
   flat `{ "p(95)<500": false }` dict (boolean = breached, not an object
   with `.ok`). The original assert (`...thresholds[...].ok == false`)
   was simply wrong for this k6 version (v1.6.1). Fixed to compare the
   boolean directly.

## Running it

```bash
# Safe suite (functional + security + monitoring + load) — run anytime
ansible-playbook playbooks/tests.yml --ask-vault-pass

# One category only
ansible-playbook playbooks/tests.yml --tags security --ask-vault-pass

# Disruptive tests — maintenance window only
ansible-playbook playbooks/tests.yml --tags ha -e pg_test_ha=true --ask-vault-pass
ansible-playbook playbooks/tests.yml --tags etcd_resilience -e pg_test_etcd_resilience=true --ask-vault-pass
ansible-playbook playbooks/tests.yml --tags watchdog -e pg_test_watchdog=true --ask-vault-pass
```

Reports land in `~/pg_test_reports/` on the control node after each run.

## Requirements

- `community.postgresql` collection: `ansible-galaxy collection install community.postgresql`
- `pgbench` (installed automatically via `postgresql-contrib` in `load.yml`)
- `k6` installed on the Ansible control node — `sudo snap install k6` is the
  simplest path on WSL/Ubuntu (the official apt repo requires a GPG key
  that isn't always resolvable; snap avoided that entirely)
- `etcdctl` on the control node or reachable via `delegate_to`

## Not yet run

The three disruptive categories (`ha`, `etcd_resilience`, `watchdog`) encode
procedures already verified **manually** during the original hardening work
(a real switchover, a real etcd node kill, a real watchdog fd check) but
haven't yet been run through this automated form. Recommended before
sign-off: schedule one maintenance window, run all three with their flags
enabled, and attach the output alongside this README as final proof the
automated suite reproduces the same manually-verified behavior.

`disaster_recovery` stays blocked until pgBackRest is deployed — see the
project's remaining IMPORTANT-severity items.

## Before running against production

1. **Run the safe suite before every deployment**, not just once. All four
   categories are read-only or self-cleaning, so this is cheap and catches
   regressions immediately.
2. **Schedule `ha` and `etcd_resilience` for an actual maintenance window**
   — these are the two tests that most directly prove split-brain
   protection and etcd quorum tolerance, the two hardest-won fixes from
   the original review.
