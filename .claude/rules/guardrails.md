# Guardrails — Always Apply

## RBAC — Discord Pattern

### Role Architecture
- Role lives on `Membership` model, NOT on `CustomUser`
- User has ONE account, joins MANY communities via Membership
- Same user can be Admin in Community A and Member in Community B
- `SuperAdmin` is `is_superadmin=True` on CustomUser — backend team only

### Role Hierarchy (per-community via Membership.role)
```
SuperAdmin (platform-level, backend only)
  Admin (per-community admin)
    └→ Organizer (creates/manages events)
    └→ Recruiter (posts/manages jobs)
         └→ Member (RSVPs, comments, saves jobs)
              └→ Guest (anonymous browse, no login)
```

### Role Check Rules
- Every view checks `membership.role` — NEVER `user.role`
- Context processor provides `{{ membership }}` to all templates
- User without Membership for current tenant = treated as Guest
- Higher roles inherit lower role permissions WITHIN same community only
- Admin in Community A has ZERO permissions in Community B

### Access Control Matrix
| Action | Guest | Member | Recruiter | Organizer | Admin | SuperAdmin |
|--------|:-----:|:------:|:---------:|:---------:|:-----:|:----------:|
| Browse events/jobs | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| RSVP/comment/like | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Save job alert | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Create event | ✗ | ✗ | ✗ | ✓ (own) | ✓ | ✓ |
| Edit event | ✗ | ✗ | ✗ | ✓ (own) | ✓ (any) | ✓ (any) |
| Delete event | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| Post job | ✗ | ✗ | ✓ (own co.) | ✗ | ✓ | ✓ |
| Edit job | ✗ | ✗ | ✓ (own) | ✗ | ✓ (any) | ✓ (any) |
| Moderate content | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| Manage users | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| View audit log | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| Manage tenants | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Cross-tenant ops | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Manage billing | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |

## Jobs Module — Transparency First
- `salary_min` and `salary_max`: REQUIRED, never nullable, never blank
- Model `clean()` rejects: zero salary, ranges >100% of min, min > max
- "competitive" must NEVER appear in salary fields
- Job browse: fully public — NO `LoginRequiredMixin` on list/detail
- Only verified recruiters can post (Company profile required first)
- Jobs API: `AllowAny` for GET, `IsRecruiter` for POST

## Security
- Permission checks at BOTH view AND template layers
- Every app has `policies.py` — single source of truth
- Never show UI buttons for actions the user can't perform
- Audit log all create/update/delete on sensitive models
- Template role checks: `{% if membership.role == 'organizer' %}`
- Payment webhooks verify the provider's HMAC signature before trusting the
  payload — an unverified webhook is a free-subscription endpoint

## Multi-Tenancy Safety
- Never cross tenant boundaries without explicit `schema_context()`
- Background tasks MUST receive `schema_name` parameter
- WebSocket consumers resolve their own tenant: the ASGI path does not run
  `TenantMainMiddleware`
- Anything keyed by a shared resource (cache, channel layer, scheduler, media
  path) MUST include the schema name in the key
- Reserved subdomain slugs: www, api, admin, app, static, media, mail,
  blog, docs, help, support, status, billing, auth, login, signup
- Custom domains: Enterprise tier only
- Billing models: public schema ONLY
- PgBouncer in transaction mode (not session mode), with the contract that
  makes it tenant-safe: the web tier runs `ATOMIC_REQUESTS=True` behind it,
  the pooler runs `server_reset_query_always = 1`, and workers, beat and
  management commands connect to Postgres directly. A tenant query outside a
  transaction through the pooler is a cross-tenant leak, not an error
  (`core/tests/test_tenant_isolation_audit.py`)
