# Code Standards — Always Apply

## Python & Django Patterns

### ALWAYS
- `pathlib.Path` over `os.path`
- f-strings over `.format()` or `%`
- Type hints on function signatures
- `related_name` on every ForeignKey and ManyToManyField
- `__str__()`, `Meta.ordering`, `Meta.verbose_name_plural` on every model
- Split settings: `base.py` / `development.py` / `production.py`
- Secrets via `python-decouple` + `.env` — never hardcode
- `get_object_or_404()` over bare `try/except DoesNotExist`
- `{% csrf_token %}` in every form template
- `ruff` formatting (Black-compatible, 88 chars)
- Imports: stdlib → third-party → Django → local apps

### NEVER
- `os.path` — use `pathlib.Path`
- `.format()` or `%` — use f-strings
- Hardcoded secrets, API keys, or credentials
- `auth.User` as AUTH_USER_MODEL — custom user only
- `ALLOWED_HOSTS = ['*']` in production
- `DEBUG = True` in production settings
- Deprecated patterns: `url()`, `{% load staticfiles %}`, `NullBooleanField`
- Hardcoded domain names — use `settings.BASE_DOMAIN`
- Real names of people, companies, or brands in code or comments
- `user.role` — role lives on Membership, NOT on User

## Authentication
- Email as login: `USERNAME_FIELD = "email"`, email `unique=True`, username `blank=True`
- Custom `UserManager` for email-based `create_user()` / `create_superuser()`
- Google OAuth via `django-allauth` — credentials in `.env`
- `ACCOUNT_AUTHENTICATION_METHOD = "email"`
- `ACCOUNT_EMAIL_REQUIRED = True`
- `ACCOUNT_USERNAME_REQUIRED = False`
- Login page: both email/password AND "Sign in with Google"

## Environment & Cross-Platform
- **`uv`** is the primary tool for venv, deps, and Python version management
- `pyproject.toml` + `uv.lock` (not `requirements.txt`)
- `uv run` for all `manage.py` commands (cross-platform, no manual activation)
- `uv add` for dependencies (not `pip install`)
- When showing venv activation, show ALL platforms:
  ```bash
  # Linux/Mac:   source .venv/bin/activate
  # Windows CMD: .venv\Scripts\activate
  # Windows PS:  .venv\Scripts\Activate.ps1
  ```
- File paths: `pathlib.Path` with `/` — never OS-specific paths

## Multi-Tenancy
- SHARED_APPS: accounts, tenants, billing, auth, contenttypes, admin
- TENANT_APPS: events, jobs, content, notifications, core
- Background tasks MUST take `schema_name` param + use `schema_context()`
- Media paths: `media/{schema_name}/`
- Cache keys: `{schema_name}:cache:key`
- Never cross tenant boundaries without explicit `schema_context()`

## Django 6 Features — Use These
- Template Partials: `{% partialdef %}` / `{% partial %}`
- CSP: `ContentSecurityPolicyMiddleware` in settings
- Built-in Tasks: `@task` decorator + `task.enqueue()`
- `forloop.length` in template loops
- `GeneratedField` auto-refresh after save

## Testing
- `pytest-django` as primary framework + `factory_boy` for test data
- Descriptive names: `test_<what_it_tests>`
- Test models, views, forms, serializers, and permissions separately
- Minimum 80% coverage target
- No manual fixtures — factories only
