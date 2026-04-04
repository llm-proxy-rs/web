mod user;

use anyhow::{Context, Result};
pub use sqlx::PgPool;
pub use user::{User, get_user_by_email, upsert_user};

pub async fn connect_db(url: &str) -> Result<PgPool> {
    let pg_pool = PgPool::connect(url)
        .await
        .context("failed to connect to database")?;
    Ok(pg_pool)
}

pub async fn run_migrations(pg_pool: &PgPool) -> Result<()> {
    sqlx::migrate!("../migrations")
        .run(pg_pool)
        .await
        .context("failed to run database migrations")?;
    Ok(())
}
