use anyhow::Result;
use sqlx::PgPool;
use uuid::Uuid;

pub struct User {
    pub id: Uuid,
    pub email: String,
}

pub async fn upsert_user(pg_pool: &PgPool, email: &str) -> Result<User> {
    let user = sqlx::query_as!(
        User,
        r#"
        INSERT INTO users (email)
        VALUES ($1)
        ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
        RETURNING id, email
        "#,
        email
    )
    .fetch_one(pg_pool)
    .await?;
    Ok(user)
}
