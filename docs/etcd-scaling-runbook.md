# etcd cluster scaling runbook — 1-node (lab) ↔ 3-node (prod)

This is a **manual, deliberate procedure**, not an Ansible-automated toggle.
Growing or shrinking etcd membership is a live, order-sensitive operation —
running it via a variable flip on a routine `site.yml` pass risks accidentally
removing real quorum members. Treat each direction below as a one-time,
supervised migration.

Two inventories exist for the two steady states:

- `inventory/lab/` — 1-node etcd (vm1 only), 2-node Postgres (vm1, vm2)
- `inventory/prod/` — 3-node etcd (vm1, vm2, vm7), 3-node Postgres (vm1, vm2, vm7)

Use `-i inventory/lab/hosts.ini` or `-i inventory/prod/hosts.ini` on every
`ansible-playbook` invocation to target the environment you mean.

---

## Grow: 1-node → 3-node etcd (lab → prod)

This is the exact sequence already used to bring vm7 into the cluster.

**1. Confirm current state — control node:**
```bash
ssh root@192.168.163.129 "etcdctl endpoint health"
```
Should show exactly 1 healthy endpoint before starting.

**2. Ensure the new etcd node (e.g. vm7) is reachable — control node:**
```bash
ansible vm7 -m ping --ask-vault-pass
```
If this fails, resolve SSH/connectivity first (see main runbook history —
sshd not installed/started is the most common cause on a fresh VM).

**3. Add the new member to the existing etcd cluster — run on the CURRENT
etcd leader (e.g. vm1), not the control node:**
```bash
ssh root@192.168.163.129
etcdctl member add vm7 --peer-urls=http://192.168.163.134:2380
```
This returns environment variables (`ETCD_NAME`, `ETCD_INITIAL_CLUSTER`,
etc.) needed by the new node's own etcd config — capture the output.

**4. Install and start etcd on the new node — control node, targeting only
the new host:**
```bash
ansible-playbook -i inventory/prod/hosts.ini playbooks/etcd.yml --limit vm7 --ask-vault-pass
```
(As of 2026-07-14, etcd installation is handled by the dedicated `roles/etcd`
role — it is NOT part of `claranet.patroni`. The role includes a safety
guard that skips any node whose `/var/lib/etcd` already has data, so it's
safe to run against a whole inventory group without disturbing already-
bootstrapped nodes. For a genuinely new node joining an existing live
cluster, this Ansible role still won't do the live `etcdctl member add`
step for you — that remains manual, since membership changes against a
running cluster are a different, riskier operation than a fresh multi-node
bootstrap. Use this role only when standing up brand-new, empty nodes
together from scratch.)

**5. Confirm quorum — control node or any node:**
```bash
ssh root@192.168.163.129 "etcdctl endpoint health"
ssh root@192.168.163.129 "etcdctl member list"
```
All 3 endpoints should report healthy.

**6. Update `patroni_etcd_hosts` for the environment going forward** —
already done in `inventory/prod/group_vars/postgres_cluster.yml`:
```yaml
patroni_etcd_hosts: "192.168.163.129:2379,192.168.163.128:2379,192.168.163.134:2379"
```

**7. Bring the new node into the Postgres/Patroni cluster itself** — see the
main VM7 onboarding notes; in short:
```bash
ansible-playbook -i inventory/prod/hosts.ini playbooks/postgres.yml --limit vm7 --ask-vault-pass
ansible-playbook -i inventory/prod/hosts.ini playbooks/patroni.yml --ask-vault-pass   # full run, not --limit — Patroni's cross-node consistency checks need every host's facts
```

**8. Verify end to end:**
```bash
ssh root@192.168.163.129 "/opt/patroni/bin/patronictl -c /etc/patroni/config.yml list"
```
Expect 3/3 nodes streaming.

**Known gotchas hit during the real vm7 grow (keep these in mind):**
- New node's local Postgres data dir must be empty/fresh before Patroni
  bootstraps it, or you'll hit a `system ID mismatch` error — wipe
  `/var/lib/postgresql/<version>/main` on the new node if `initdb` ran
  there previously via `claranet.postgresql` before Patroni took over.
- The Leader's live `pg_hba.conf` won't pick up the new node's replication
  rule automatically — push it via `patronictl edit-config`, not just the
  new node's local static config.
- Any extensions in `shared_preload_libraries` (e.g. `pgaudit`) must have
  their packages installed on the new node — `claranet.postgresql`'s
  package list should already include this after the fix applied
  2026-07-13; confirm before assuming.
- A standalone systemd `watchdog.service` may conflict with Patroni's own
  watchdog fd — mask it (`systemctl mask watchdog`) on every Patroni node
  if this happens.

---

## Shrink: 3-node → 1-node etcd (prod → lab teardown)

Only do this for tearing down a lab environment — never on a live
production cluster with real data you care about, since you're
deliberately giving up quorum tolerance.

**1. Stop Postgres/Patroni on the nodes being removed first (e.g. vm7) —
control node:**
```bash
ssh root@192.168.163.134 "systemctl stop patroni"
```

**2. Remove the etcd member — run from a REMAINING node (e.g. vm1), using
the member ID (not name):**
```bash
ssh root@192.168.163.129
etcdctl member list          # note the hex ID for vm7
etcdctl member remove <vm7-member-id>
```

**3. Confirm remaining quorum is healthy:**
```bash
etcdctl endpoint health
```

**4. Stop etcd on the removed node:**
```bash
ssh root@192.168.163.134 "systemctl stop etcd"
```

**5. Switch inventory target to `inventory/lab/` for all subsequent runs:**
```bash
ansible-playbook -i inventory/lab/hosts.ini playbooks/site.yml --ask-vault-pass
```

**6. Verify:**
```bash
ssh root@192.168.163.129 "etcdctl endpoint health"
ssh root@192.168.163.129 "/opt/patroni/bin/patronictl -c /etc/patroni/config.yml list"
```
Should show 1 etcd endpoint healthy, and only the remaining Postgres nodes
in the Patroni cluster list.

---

## Why this isn't automated in Ansible

- etcd membership changes are order-dependent and require a live
  `etcdctl member add/remove` step against a running cluster — not
  something `ansible-playbook` can safely infer from a diff between two
  inventory files.
- A mistaken `state: absent` on the wrong node, or a reconciliation loop
  triggered by an inventory typo, could remove a real quorum member and
  take down leader election cluster-wide.
- Keeping this as an explicit, human-triggered runbook — mirroring exactly
  what was done by hand for the original vm7 addition — means every
  membership change is deliberate, reviewed, and reversible one step at a
  time.
