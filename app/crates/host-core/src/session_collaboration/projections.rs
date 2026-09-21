use std::collections::HashSet;

use super::{repository, string};
use crate::db::{ms_to_ts, now_ms, Database};
use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

const MAX_CREATED_SESSIONS: i64 = 8;
const MAX_DISCOVERABLE_SESSIONS: i64 = 100;

/// A ledger reference survives the deletion of the session it points at, so it
/// reports availability instead of silently disappearing.
fn creator(db: &Database, session_id: &str) -> Result<Option<Value>> {
    let value: Option<(String, String, bool)> = db
        .conn()
        .query_row(
            "SELECT l.created_by_session_id,COALESCE(NULLIF(s.title,''),l.created_by_session_id),
        (s.id IS NOT NULL AND s.deleted_at IS NULL)
        FROM session_collaboration_links l LEFT JOIN sessions s ON s.id=l.created_by_session_id
        WHERE l.session_id=?1",
            params![session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    Ok(value.map(|(session_id, title, available)| {
        json!({"sessionId":session_id,"title":title,"available":available})
    }))
}

fn created_sessions(db: &Database, session_id: &str) -> Result<Vec<Value>> {
    let mut statement = db.conn().prepare_cached(
        "SELECT s.id,COALESCE(NULLIF(s.title,''),s.id)
        FROM session_collaboration_links l JOIN sessions s ON s.id=l.session_id
        WHERE l.created_by_session_id=?1 AND s.deleted_at IS NULL
        ORDER BY l.created_at DESC,l.session_id DESC LIMIT ?2",
    )?;
    let rows = statement.query_map(params![session_id, MAX_CREATED_SESSIONS], |row| {
        Ok(json!({"sessionId":row.get::<_, String>(0)?,"title":row.get::<_, String>(1)?,"available":true}))
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// The session on the far side of a ledger message, relative to `session_id`.
fn peer_session_id<'a>(message: &'a repository::Message, session_id: &str) -> &'a str {
    if message.target_session_id == session_id {
        &message.source_session_id
    } else {
        &message.target_session_id
    }
}

/// Availability of the referenced peer sessions. One bounded lookup resolves
/// the distinct ids; it never scans or loads the sessions table.
fn available_sessions(db: &Database, session_ids: &[String]) -> Result<HashSet<String>> {
    let mut distinct: Vec<&str> = session_ids
        .iter()
        .map(String::as_str)
        .filter(|id| !id.is_empty())
        .collect();
    distinct.sort_unstable();
    distinct.dedup();
    if distinct.is_empty() {
        return Ok(HashSet::new());
    }
    let placeholders = (1..=distinct.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(",");
    let mut statement = db.conn().prepare_cached(&format!(
        "SELECT id FROM sessions WHERE id IN ({placeholders}) AND deleted_at IS NULL"
    ))?;
    let rows = statement.query_map(rusqlite::params_from_iter(distinct), |row| {
        row.get::<_, String>(0)
    })?;
    Ok(rows.collect::<rusqlite::Result<HashSet<_>>>()?)
}

fn model_fields(
    db: &Database,
    session_id: &str,
) -> Result<(Option<String>, Option<String>, Option<String>)> {
    let (provider_id, model_id, provider_name, model_name): (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = db.conn().query_row(
        "SELECT s.provider_id,s.model_id,p.name,m.display_name
        FROM sessions s
        LEFT JOIN providers p ON p.id=s.provider_id
        LEFT JOIN models m ON m.provider_id=s.provider_id AND m.model_id=s.model_id
        WHERE s.id=?1",
        params![session_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    let model_key = match (provider_id.as_deref(), model_id.as_deref()) {
        (Some(provider), Some(model)) if !provider.is_empty() && !model.is_empty() => {
            Some(format!("{provider}/{model}"))
        }
        _ => None,
    };
    let model_name = model_name.or(model_id);
    Ok((model_key, provider_name, model_name))
}

fn status(db: &Database, session_id: &str) -> Result<String> {
    let turn: Option<(String, String)> = db.conn().query_row(
        "SELECT id,status FROM turns WHERE session_id=?1 ORDER BY started_at DESC,rowid DESC LIMIT 1",
        params![session_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    let current = db
        .conn()
        .prepare_cached(&format!(
            "{} WHERE target_session_id=?1
        ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
        created_at DESC,rowid DESC LIMIT 1",
            repository::SELECT
        ))?
        .query_row(params![session_id], repository::row)
        .optional()?;
    let mut value = match turn.as_ref().map(|(_, value)| value.as_str()) {
        Some("running") => "running",
        Some("completed") => "completed",
        Some("error") => "failed",
        Some("aborted") => "cancelled",
        _ => "idle",
    };
    if let Some(message) = &current {
        if value != "running"
            && (turn.is_none()
                || message.status == "queued"
                || message.turn_id.as_deref() == turn.as_ref().map(|(id, _)| id.as_str()))
        {
            value = &message.status;
        }
    }
    Ok(value.to_string())
}

pub(super) fn result(db: &Database, input: &Value) -> Result<Value> {
    let session_id = string(input, "sessionId", 256)?;
    repository::title(db, session_id)?;
    let message = match input.get("messageId").and_then(Value::as_str) {
        Some(id) => repository::get(db, id)?,
        None => repository::latest_incoming(
            db,
            session_id,
            input.get("turnId").and_then(Value::as_str),
        )?,
    };
    if input.get("messageId").is_some() && message.is_none() {
        return Err(anyhow!("NOT_FOUND: session message"));
    }
    if message
        .as_ref()
        .is_some_and(|value| value.target_session_id != session_id)
    {
        return Err(anyhow!("NOT_FOUND: message for session"));
    }
    let ready = message
        .as_ref()
        .is_some_and(|value| !matches!(value.status.as_str(), "queued" | "running"));
    Ok(json!({"ready":ready,"message":message}))
}

pub(super) fn summary(db: &Database, id: &str) -> Result<Value> {
    let title = repository::title(db, id)?;
    let creator = creator(db, id)?;
    let turn: Option<(String,String)> = db.conn().query_row(
        "SELECT id,status FROM turns WHERE session_id=?1 ORDER BY started_at DESC,rowid DESC LIMIT 1",
        params![id],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
    let current = db
        .conn()
        .prepare_cached(&format!(
            "{} WHERE target_session_id=?1
        ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
        created_at DESC,rowid DESC LIMIT 1",
            repository::SELECT
        ))?
        .query_row(params![id], repository::row)
        .optional()?;
    let mut status = match turn.as_ref().map(|(_, status)| status.as_str()) {
        Some("running") => "running",
        Some("completed") => "completed",
        Some("error") => "failed",
        Some("aborted") => "cancelled",
        _ => "idle",
    }
    .to_string();
    if let Some(message) = &current {
        if status != "running"
            && (turn.is_none()
                || message.status == "queued"
                || message.turn_id.as_deref() == turn.as_ref().map(|(id, _)| id.as_str()))
        {
            status = message.status.clone();
        }
    }
    let (model_key, provider_name, model_name) = model_fields(db, id)?;
    // Peer references come from the ledger, so resolve their availability with
    // one bounded lookup for the at most five distinct referenced sessions.
    let current_task = current.filter(|message| {
        message.status == "queued"
            || message.turn_id.as_deref() == turn.as_ref().map(|(id, _)| id.as_str())
    });
    let recent = repository::recent(db, id, 4)?;
    let mut referenced: Vec<String> = recent
        .iter()
        .map(|message| peer_session_id(message, id).to_owned())
        .collect();
    if let Some(message) = &current_task {
        referenced.push(message.source_session_id.clone());
    }
    let available = available_sessions(db, &referenced)?;
    let exchanges: Vec<Value> = recent.into_iter().map(|message| {
        let incoming = message.target_session_id == id;
        let peer_id = if incoming {
            message.source_session_id.clone()
        } else {
            message.target_session_id.clone()
        };
        let peer_available = available.contains(&peer_id);
        let peer_title = if incoming { &message.source_title } else { &message.target_title };
        json!({"messageId":message.id,"direction":if incoming {"incoming"}else{"outgoing"},
            "peer":{"sessionId":peer_id,"title":peer_title,"available":peer_available},
            "kind":message.kind,"status":message.status,"preview":repository::bounded(&message.content,240),"createdAt":message.created_at})
    }).collect();
    let mut value = json!({"sessionId":id,"title":title,"status":status,"observedAt":ms_to_ts(now_ms()),"recentExchanges":exchanges});
    if let Some(model) = model_key {
        value["modelKey"] = json!(model);
    }
    if let Some(name) = provider_name {
        value["providerName"] = json!(name);
    }
    if let Some(name) = model_name {
        value["modelName"] = json!(name);
    }
    if let Some(created_by) = creator {
        value["createdBySession"] = created_by;
    }
    let created = created_sessions(db, id)?;
    if !created.is_empty() {
        value["createdSessions"] = json!(created);
    }
    if let Some(message) = current_task {
        let sender_available = available.contains(&message.source_session_id);
        value["currentTask"] = json!({"messageId":message.id,"senderSession":{"sessionId":message.source_session_id,"title":message.source_title,"available":sender_available},
            "text":repository::bounded(&message.content,512),"status":message.status,"turnId":message.turn_id,"createdAt":message.created_at});
        if !matches!(message.status.as_str(), "queued" | "running")
            && message.turn_id.as_deref() == turn.as_ref().map(|(id, _)| id.as_str())
        {
            value["result"] = json!({"messageId":message.id,"turnId":message.turn_id,"status":message.status,"text":message.result,"error":message.error});
        }
    }
    if let Some(task) = value.get_mut("currentTask").and_then(Value::as_object_mut) {
        task.retain(|_, value| !value.is_null());
    }
    if let Some(result) = value.get_mut("result").and_then(Value::as_object_mut) {
        result.retain(|_, value| !value.is_null());
    }
    Ok(value)
}

pub(super) fn list(db: &Database) -> Result<Value> {
    let mut statement = db.conn().prepare_cached(
        "SELECT s.id,COALESCE(NULLIF(s.title,''),s.id),s.provider_id,s.model_id,
            p.name,m.display_name,s.updated_at
        FROM sessions s
        LEFT JOIN providers p ON p.id=s.provider_id
        LEFT JOIN models m ON m.provider_id=s.provider_id AND m.model_id=s.model_id
        WHERE s.deleted_at IS NULL AND s.mode='agent'
        ORDER BY s.updated_at DESC,s.id DESC LIMIT ?1",
    )?;
    let rows = statement.query_map(params![MAX_DISCOVERABLE_SESSIONS], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, i64>(6)?,
        ))
    })?;
    let sessions = rows
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(
            |(id, title, provider_id, model_id, provider_name, model_name, updated_at)| {
                let model_key = match (provider_id.as_deref(), model_id.as_deref()) {
                    (Some(provider), Some(model)) if !provider.is_empty() && !model.is_empty() => {
                        Some(format!("{provider}/{model}"))
                    }
                    _ => None,
                };
                let model_name = model_name.or(model_id);
                let mut item = json!({
                    "sessionId": id,
                    "title": title,
                    "status": status(db, &id)?,
                    "updatedAt": ms_to_ts(updated_at),
                });
                if let Some(model) = model_key {
                    item["modelKey"] = json!(model);
                }
                if let Some(name) = provider_name {
                    item["providerName"] = json!(name);
                }
                if let Some(name) = model_name {
                    item["modelName"] = json!(name);
                }
                if let Some(created_by) = creator(db, &id)? {
                    item["createdBySession"] = created_by;
                }
                let created = created_sessions(db, &id)?;
                if !created.is_empty() {
                    item["createdSessions"] = json!(created);
                }
                Ok(item)
            },
        )
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({"sessions":sessions}))
}
