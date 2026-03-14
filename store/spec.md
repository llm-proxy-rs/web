# store

PostgreSQL persistence layer for user accounts.

## Responsibilities

- Connect to PostgreSQL and run migrations on startup
- Upsert users by email (create on first login, return existing on subsequent logins)

## Schema

### `users`

| Column | Type | Description |
|---|---|---|
| `id` | `UUID` | Primary key |
| `email` | `TEXT` | Unique user email from Cognito |

## API

```
connect_db(url: &str) -> Result<PgPool>
run_migrations(pg_pool: &PgPool) -> Result<()>
upsert_user(pg_pool: &PgPool, email: &str) -> Result<User>
```
