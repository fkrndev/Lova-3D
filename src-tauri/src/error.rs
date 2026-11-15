//! Structured, serializable command errors — the frontend receives
//! `{ kind, message }` instead of bare strings.
use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Serialize)]
pub struct LovaError {
    pub kind: &'static str,
    pub message: String,
}

impl LovaError {
    pub fn io(message: impl Into<String>) -> Self {
        Self { kind: "io", message: message.into() }
    }
    pub fn not_a_project(message: impl Into<String>) -> Self {
        Self { kind: "not_a_project", message: message.into() }
    }
    pub fn illegal_path(message: impl Into<String>) -> Self {
        Self { kind: "illegal_path", message: message.into() }
    }
    pub fn db(message: impl Into<String>) -> Self {
        Self { kind: "db", message: message.into() }
    }
}

impl fmt::Display for LovaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl From<std::io::Error> for LovaError {
    fn from(e: std::io::Error) -> Self {
        Self::io(e.to_string())
    }
}

impl From<rusqlite::Error> for LovaError {
    fn from(e: rusqlite::Error) -> Self {
        Self::db(e.to_string())
    }
}
