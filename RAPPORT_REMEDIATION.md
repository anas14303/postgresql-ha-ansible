# Rapport de remédiation — Revue postgresql-ha-ansible

**Date :** 13 juillet 2026
**Périmètre :** Cluster PostgreSQL/Patroni HA (vm1, vm2) + etcd (vm1, vm2, vm7) + Keycloak HA (vm5, vm6) + HAProxy/Keepalived (vm3) + Vault PKI (vm4)
**Référence :** Revue `postgresql-ha-review-bancaire.html` du 02/07/2026

---

## Synthèse

| Sévérité | Total revue | Corrigés | Restants |
|---|---|---|---|
| 🔴 CRITIQUE (bloquant prod) | 6 | **6** | 0 |
| 🟠 IMPORTANT | 5 | 0 | 5 |
| 🟡 MOYEN | 2 | 0 | 2 |
| 🟢 FAIBLE | 2 | 0 | 2 |

**Les 6 points bloquants pour un déploiement bancaire sont désormais corrigés et vérifiés par des tests automatisés reproductibles** (voir `roles/postgres_tests/`). Chaque correction ci-dessous inclut la preuve de validation réelle, pas seulement la modification de configuration.

---

## 🔴 Points CRITIQUE — tous corrigés

### 1. Secrets Ansible en clair

**Constat de la revue :** tous les mots de passe (superuser Postgres, réplication, Grafana, utilisateurs applicatifs) étaient stockés en clair dans `inventory/group_vars/`, visibles par quiconque a accès au dépôt.

**Aggravation découverte en cours de remédiation :** ces secrets avaient déjà été poussés sur un dépôt GitHub **public**, donc potentiellement exposés/indexés avant même cette revue.

**Correction appliquée :**
- Tous les mots de passe migrés vers `ansible-vault` (`inventory/group_vars/all/vault.yml`, chiffré AES-256)
- Chaque fichier de variables référence désormais `{{ vault_* }}` au lieu de valeurs en clair
- **Rotation complète** de chaque mot de passe exposé sur l'infrastructure réelle (superuser, replicator, exporter, Grafana, app_admin, app_readwrite, app_readonly)
- **Historique Git nettoyé** avec `git-filter-repo` — les anciennes valeurs ont été remplacées par `REDACTED` dans tous les commits, puis un `force-push` a réécrit l'historique distant
- Authentification Vault PKI (pour Keycloak) migrée du root token vers **AppRole** (role_id/secret_id), conforme aux bonnes pratiques de moindre privilège

**Preuve :**
```bash
git log --all -p | grep -iE "exp0rt3r|grafanaadmin|admnpass|sup3rs3cur3|repl.catorpass"
# → aucun résultat (historique confirmé propre)
```

---

### 2. Watchdog / protection split-brain absente

**Constat de la revue :** `watchdog.mode: off` — aucune protection contre le split-brain en cas de gel du processus Patroni.

**Correction appliquée :**
- Module noyau `softdog` chargé sur vm1 et vm2
- Permissions `/dev/watchdog` corrigées via groupe dédié + règle udev (`crw-rw---- root watchdog`)
- `watchdog.mode: required` activé dans la configuration Patroni **statique** (`/etc/patroni/config.yml`) — point important : la configuration dynamique (`patronictl edit-config`) seule ne suffit pas, le fichier statique fait autorité sur ce paramètre

**Bug non documenté découvert pendant la remédiation :** la configuration dynamique et le fichier statique local de Patroni peuvent diverger silencieusement, sans erreur ni avertissement. Le watchdog était configuré correctement côté DCS (etcd) mais restait inactif car le fichier statique local (`/etc/patroni/config.yml`) contenait encore `mode: off`. Ce point n'est mentionné dans aucune documentation Patroni consultée — corrigé après investigation du code source (`patroni/watchdog/base.py`).

**Preuve — test de promotion réelle :**
```
INFO: Software Watchdog activated with 25 second timeout, timing slack 15 seconds
l-wx------ 1 postgres postgres 64 ... 6 -> /dev/watchdog
```
Vérifié automatiquement par `roles/postgres_tests/tasks/security.yml` (assertion sur `watchdog.mode == required`) et `roles/postgres_tests/tasks/watchdog.yml` (vérification du file descriptor ouvert sur le leader réel).

---

### 3. PostgreSQL `listen_addresses = '*'`

**Constat de la revue :** Postgres écoutait sur toutes les interfaces réseau (`0.0.0.0`), y compris des interfaces futures non prévues.

**Correction appliquée :**
- `listen_addresses` restreint à `127.0.0.1,192.168.163.129,192.168.163.128` (loopback + IPs des deux nœuds du cluster uniquement)
- Corrigé via le paramètre `listen:` de Patroni (paramètre de contexte *postmaster*, nécessitant un redémarrage complet — pas un simple *reload*)

**Preuve :**
```sql
SHOW listen_addresses;
-- 127.0.0.1,192.168.163.129,192.168.163.128
```
Vérifié automatiquement (`roles/postgres_tests/tasks/security.yml` — assertion `'0.0.0.0' not in listen_addresses`).

---

### 4. pg_hba — connexions non-SSL acceptées

**Constat de la revue :** règles `host` (acceptant SSL et non-SSL) au lieu de `hostssl` (rejetant tout ce qui n'est pas chiffré).

**Correction appliquée :**
- Toutes les règles `host` migrées vers `hostssl` dans `/etc/patroni/config.yml` (statique, sur vm1 et vm2)
- Règles explicites ajoutées pour chaque flux réel : réplication (vm1↔vm2), superuser, Keycloak (vm5/vm6)

**Preuve — test de rejet réel :**
```bash
psql "host=192.168.163.129 ... sslmode=disable" -c "SELECT 1"
# → FATAL: no pg_hba.conf entry ... no encryption   (rejeté, comme attendu)

psql "host=192.168.163.129 ... sslmode=require" -c "SELECT 1"
# → 1 (accepté normalement)
```
Vérifié automatiquement (`roles/postgres_tests/tasks/security.yml` — tentative de connexion sans SSL doit échouer, tentative de connexion avec SSL doit réussir).

---

### 5. pgAudit absent

**Constat de la revue :** aucune traçabilité des requêtes exécutées — non conforme ACPR/PCI-DSS.

**Correction appliquée :**
- Package `postgresql-16-pgaudit` installé sur vm1 et vm2
- `shared_preload_libraries: pgaudit` + `pgaudit.log: 'write, ddl, role'` configurés
- Extension activée (`CREATE EXTENSION pgaudit`)

**Preuve — capture réelle en production (trafic Keycloak) :**
```
LOG:  AUDIT: SESSION,1,1,WRITE,DELETE,,,DELETE FROM JGROUPSPING WHERE own_addr=$1 AND cluster_name=$2,...
```
Vérifié automatiquement (`roles/postgres_tests/tasks/security.yml` — assertion `pgaudit` présent dans `shared_preload_libraries`).

---

### 6. etcd — nœud unique (pas de quorum Raft)

**Constat de la revue :** un seul nœud etcd, donc aucune tolérance de panne sur la couche DCS dont dépend l'élection du leader Patroni.

**Correction appliquée :**
- 7ᵉ VM provisionnée comme nœud etcd dédié
- Migration à chaud vers un cluster etcd 3 nœuds (vm1, vm2, vm7) via `etcdctl member add` — sans interruption de service ni perte de données
- Configuration Patroni mise à jour (`patroni_etcd_hosts`) pour connaître les 3 endpoints

**Preuve — test de tolérance de panne réel :**
```bash
# arrêt volontaire de l'etcd sur vm7
systemctl stop etcd

# cluster Postgres : AUCUN impact
patronictl list
# vm1 Sync Standby streaming | vm2 Leader running   ← inchangé

etcdctl endpoint health   # 2 nœuds restants
# → tous healthy (quorum 2-sur-3 maintenu)
```
Vérifié automatiquement (`roles/postgres_tests/tasks/etcd_resilience.yml` — arrêt réel d'un nœud, assertion que le leader Postgres ne change pas, redémarrage et vérification du retour au quorum complet).

---

## 🟠 Points IMPORTANT — non traités (hors périmètre de cette session)

| Point | Statut |
|---|---|
| TLS etcd + Patroni REST API (mTLS) | Non commencé |
| Tuning mémoire dynamique (`ansible_memtotal_mb`) | Non commencé |
| pgBouncer (connection pooling) | Non commencé |
| Backup — migration pg_dump → pgBackRest + WAL archiving | Non commencé — bloque la catégorie de test `disaster_recovery` (scaffold uniquement, voir `roles/postgres_tests/tasks/disaster_recovery.yml`) |
| Alertmanager | Non commencé |

## 🟡 Points MOYEN / 🟢 FAIBLE — non traités

Non prioritaires pour la mise en production initiale ; à traiter dans une itération ultérieure (HAProxy `maxconn`, SSO Grafana, guards de régénération SSL/backup).

---

## Suite de tests automatisée — nouveauté hors périmètre initial de la revue

En parallèle de cette remédiation, une suite de tests Ansible + k6 + pgbench a été construite (`roles/postgres_tests/`) pour valider en continu, avant chaque mise en production, que les 6 points critiques restent corrigés — et pas seulement au moment de cette revue. Voir `roles/postgres_tests/README.md` pour le détail complet.

Résultat du dernier passage complet (suite non-destructive) :
```
PLAY RECAP
vm1 : ok=55  changed=8  unreachable=0  failed=0  skipped=4  rescued=0  ignored=0
```
- pgbench : 289 TPS (seuil minimum : 50 TPS)
- k6 (API REST Patroni) : p95 = 25ms (seuil : 500ms), 0% erreurs
- Réplication : lag = 0 octet
- etcd : 3/3 nœuds healthy
