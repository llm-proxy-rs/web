use anyhow::Result;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

#[derive(FromRow)]
pub struct User {
    pub id: Uuid,
    pub email: String,
}

pub async fn upsert_user(pg_pool: &PgPool, email: &str) -> Result<User> {
    let user = sqlx::query_as::<_, User>(
        r#"
        INSERT INTO users (email)
        VALUES ($1)
        ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
        RETURNING id, email
        "#,
    )
    .bind(email)
    .fetch_one(pg_pool)
    .await?;
    Ok(user)
}

pub async fn get_user_by_email(pg_pool: &PgPool, email: &str) -> Result<Option<User>> {
    let user = sqlx::query_as::<_, User>("SELECT id, email FROM users WHERE email = $1")
        .bind(email)
        .fetch_optional(pg_pool)
        .await?;
    Ok(user)
}
