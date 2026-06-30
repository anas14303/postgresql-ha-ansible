# postgres-devops

A production-style, self-healing PostgreSQL 16 cluster built entirely with Ansible: streaming replication, automatic failover via Patroni, role-based database access, automated backups, and full Prometheus/Grafana monitoring.

This project was built as a DevOps internship deliverable, starting from a "basic" PostgreSQL Ansible role and extended into a complete six-phase platform.

---

## Architecture

```
                         ┌────────────────────────────────────────┐
                         │              Control Node               │
                         │         WSL Ubuntu (Windows host)        │
                         │     Ansible 2.20 · ansible-galaxy        │
                         └───────────────────┬──────────────────────┘
                                              │ SSH
                  ┌───────────────────────────┴───────────────────────────┐
                  │                                                       │
        ┌─────────▼─────────┐                                  ┌─────────▼─────────┐
        │   VM1 (server1)    │                                  │   VM2 (server2)    │
        │ 192.168.163.129    │      streaming replication       │ 192.168.163.128    │
        │                     │  ◄─────────────────────────────►  │                     │
        │  PostgreSQL 16      │       (managed by Patroni)        │  PostgreSQL 16      │
        │  Patroni            │                                    │  Patroni            │
        │  etcd (DCS)         │                                    │                     │
        │  node_exporter      │                                    │  node_exporter      │
        │  postgres_exporter  │                                    │  postgres_exporter  │
        │  Prometheus         │                                    │                     │
        │  Grafana            │                                    │                     │
        └─────────────────────┘                                  └─────────────────────┘
```

Either VM can be the Patroni Leader at any time — the cluster automatically elects a new leader if the current one fails, and the old leader rejoins as a replica once it recovers.

---

## Project structure

```
postgres-devops/
├── ansible.cfg
├── inventory/
│   ├── hosts.ini
│   └── group_vars/
│       ├── all.yml                  # global vars: PostgreSQL, backups, monitoring, Grafana
│       ├── primary.yml              # VM1-only replication vars
│       ├── replica.yml              # VM2-only replication vars
│       ├── postgres_cluster.yml     # Patroni cluster identity, etcd, exporter creds
│       └── app_objects.yml          # databases, users, privileges
├── playbooks/
│   ├── site.yml                     # full pipeline, run this for a complete deploy
│   ├── postgres.yml                 # PostgreSQL install/config (Patroni-aware)
│   ├── patroni.yml                  # Patroni HA cluster
│   ├── backup.yml                   # backups (Patroni-aware, leader only)
│   ├── monitoring.yml               # node_exporter + postgres_exporter + Prometheus
│   └── grafana.yml                  # Grafana + dashboards
├── roles/
│   ├── claranet.postgresql/         # third-party, PostgreSQL lifecycle management
│   └── claranet.patroni/            # third-party, Patroni HA orchestration
└── README.md
```

Third-party roles (`claranet.postgresql`, `claranet.patroni`) and collections (`prometheus.prometheus`, `grafana.grafana`) are kept separate from project-specific configuration in `inventory/group_vars/`, following standard Ansible project conventions. This means the roles can be updated independently without touching any of our customizations.

---

## Phases

### Phase 1 — Infrastructure
Two Debian 13 VMs, SSH key access from the WSL control node, Ansible inventory and `ansible.cfg`, PostgreSQL 16 installed via the Claranet role.

### Phase 2 — Streaming replication
VM1 configured as primary, VM2 as a physical streaming replica using `pg_basebackup`. Verified via `pg_stat_replication` showing `state = streaming` with zero lag.

### Phase 3 — High availability with Patroni
Patroni manages the cluster lifecycle on top of PostgreSQL, using a single-node etcd instance on VM1 as the Distributed Configuration Store (DCS). Patroni automatically elects a leader, manages replication, and promotes a replica if the leader fails.

Failover was tested by stopping Patroni on the active leader; the standby was promoted within seconds, and the original leader rejoined automatically as a replica once restarted.

### Phase 4 — Database objects, users, and privileges
Three application databases (`appdb_crm`, `appdb_analytics`, `appdb_inventory`) and three role-based users, modeled on a typical application access pattern:

| User             | Access level | Databases                          |
|------------------|---------------|-------------------------------------|
| `app_admin`      | rwx (ALL)     | all three                           |
| `app_readwrite`  | rw            | `appdb_crm`, `appdb_inventory`      |
| `app_readonly`   | r (SELECT)    | all three                           |

All objects are defined declaratively in `inventory/group_vars/app_objects.yml` — no manual SQL.

Object management is **Patroni-aware**: it only runs against whichever node is currently the Leader, since replicas are read-only and cannot accept `CREATE DATABASE` / `GRANT` statements.

### Phase 5 — Automated backups
Daily, weekly, and monthly logical backups (`pg_dump`-based, via `autopostgresqlbackup`) with configurable retention, scheduled via cron at 02:00 daily. Like database object management, backups are configured to run only on the current Patroni Leader.

### Phase 6 — Monitoring
- **node_exporter** on both VMs — CPU, memory, disk, systemd metrics
- **postgres_exporter** on both VMs — connection counts, replication lag, query stats, via a dedicated `pg_monitor` PostgreSQL role
- **Patroni REST API** — scraped directly for cluster state
- **Prometheus** on VM1 — scrapes all of the above every 15s
- **Grafana** on VM1 — Node Exporter Full and PostgreSQL dashboards, Prometheus as the default datasource

---

## Running the full deployment

From the control node (WSL Ubuntu):

```bash
cd ~/postgres-devops
ansible all -m ping                 # verify connectivity first
ansible-playbook playbooks/site.yml # full deploy, idempotent
```

`site.yml` runs every phase in order: PostgreSQL → Patroni → backups → monitoring → Grafana. It is safe to re-run at any time; nearly every task is idempotent and will report `changed=0` on a stable cluster.

To deploy a single phase only, run its playbook directly, e.g.:

```bash
ansible-playbook playbooks/monitoring.yml
```

---

## Verifying cluster health

**Patroni cluster state:**
```bash
/opt/patroni/bin/patronictl -c /etc/patroni/config.yml list
```

**Replication status (run on whichever node is Leader):**
```bash
sudo -u postgres psql -c "SELECT client_addr, state, replay_lsn FROM pg_stat_replication;"
```

**Prometheus targets:**
```
http://192.168.163.129:9090/targets
```

**Grafana dashboards:**
```
http://192.168.163.129:3000
```

---

## Known limitations and production considerations

This project is built for a lab/internship environment with two VMs. A few deliberate simplifications are worth calling out, along with what a production deployment would do differently:

- **Single-node etcd.** A production DCS needs 3 or 5 nodes for quorum and fault tolerance. With two VMs, a 3-node etcd cluster wasn't possible without dedicating a third host.
- **SSL is disabled.** The Claranet PostgreSQL role's default snakeoil certificate handling triggered a role bug (see below); SSL was disabled rather than worked around with placeholder certs, since fake certs provide no real security and a production environment would issue certs from a proper CA.
- **Single Prometheus/Grafana node.** Both run on VM1 alongside PostgreSQL/Patroni. A production setup would place monitoring on a dedicated host so it stays available even if VM1 goes down.
- **Backups are local-disk only.** Production backups should ship off-host (S3, a backup server, etc.) to survive a full VM loss.
- **No alerting configured.** Prometheus is scraping metrics but no Alertmanager or alert rules are defined yet — a natural next phase.

---

## Notable issues debugged during this project

Several real upstream Ansible role bugs were found and fixed while building this project, which is worth highlighting as it reflects actual production debugging rather than following a tutorial:

1. **`claranet.postgresql` SSL task** — a `when:` clause evaluated a Jinja string as a boolean, which newer Ansible versions reject. Fixed by adding the `| bool` filter, then ultimately disabling SSL as the cleaner choice for this lab.
2. **`pg_hba.conf` template field names** — the role's HBA entry variables use `contype`/`databases`/`users`/`method`, not the more intuitive `type`/`database`/`user`/`auth_method`. Found by reading the role's Jinja template directly rather than guessing.
3. **PostgreSQL 17/16 port conflict** — a stray pre-installed PostgreSQL 17 cluster was occupying port 5432; removed to let the Ansible-managed PostgreSQL 16 cluster start cleanly.
4. **Missing CIDR notation** — replication `pg_hba.conf` entries need explicit `/32` suffixes; PostgreSQL fails to parse a bare IP as an address mask.
5. **`claranet.patroni` restart-order bug** — a task referencing `{{ item }}` via `delegate_to` crashes when the loop list is empty, because `delegate_to` resolves before the task's `when:` guard. Patched with `ignore_errors: true` since the task is only relevant when restarts are actually pending.
6. **etcd v2 API requirement** — Patroni's etcd client uses the v2 API by default; etcd 3.5 requires `--enable-v2=true` to expose it, otherwise Patroni fails to discover cluster members.
7. **PostgreSQL timeline divergence** — after a VM restart, a replica's local WAL history diverged from the new Patroni-promoted primary's timeline, causing a `FATAL: requested timeline N is not a child of this server's history` error. Resolved by wiping the stale data directory and letting Patroni re-clone the node via a fresh `pg_basebackup`.
8. **Read-only-replica object management** — database/user/privilege management was initially running against whichever VM happened to be hit first, including replicas, which reject `GRANT`/`CREATE DATABASE` as read-only transactions. Fixed by querying the Patroni REST API (`/master`) in a pre-task and gating all object/backup management behind an `is_primary` fact.
9. **Grafana admin password not applying** — `admin_password` in `grafana.ini` is only read on first database initialization; once `grafana.db` exists, subsequent changes are ignored. Resolved via `grafana cli admin reset-admin-password`.

---

## Credentials reference (lab environment only)

| Service | User | Notes |
|---|---|---|
| PostgreSQL superuser | `postgres` | set via Patroni bootstrap |
| Replication | `replicator` | used by both streaming replication and Patroni |
| App admin | `app_admin` | full access to all three app databases |
| App read-write | `app_readwrite` | `appdb_crm`, `appdb_inventory` |
| App read-only | `app_readonly` | all three app databases |
| Monitoring | `postgres_exporter` | `pg_monitor` role, read-only stats access |
| Grafana | `admin` | dashboard and datasource administration |

All passwords are stored in plaintext in `inventory/group_vars/` for this lab project. **In a production environment these must be moved to Ansible Vault** (`ansible-vault encrypt inventory/group_vars/all.yml`) before the repository is shared or committed anywhere.
