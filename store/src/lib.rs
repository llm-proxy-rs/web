mod user;

use anyhow::Result;
pub use sqlx::PgPool;
pub use user::{User, upsert_user};

pub async fn connect_db(url: &str) -> Result<PgPool> {
    let pg_pool = PgPool::connect(url).await?;
    Ok(pg_pool)
}

pub async fn run_migrations(pg_pool: &PgPool) -> Result<()> {
    sqlx::migrate!("../migrations").run(pg_pool).await?;
    Ok(())
}
