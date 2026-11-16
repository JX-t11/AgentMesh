use serde::{Deserialize, Deserializer, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct Slug(String);

impl Slug {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for Slug {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        validate_slug(&raw).map(Self).map_err(serde::de::Error::custom)
    }
}

fn validate_slug(raw: &str) -> Result<String, &'static str> {
    let s = raw.trim();
    if s.is_empty() || s.len() > 64 {
        return Err("slug length must be between 1 and 64 characters");
    }
    let mut chars = s.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return Err("slug must start with lowercase ASCII letter or digit");
    }
    if !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_') {
        return Err("slug may only contain lowercase ASCII letters, digits, '-' or '_'");
    }
    Ok(s.to_owned())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct NonEmptyText<const MAX_CHARS: usize>(String);

impl<const MAX_CHARS: usize> NonEmptyText<MAX_CHARS> {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de, const MAX_CHARS: usize> Deserialize<'de> for NonEmptyText<MAX_CHARS> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(serde::de::Error::custom("text must not be empty or whitespace-only"));
        }
        if trimmed.chars().count() > MAX_CHARS {
            return Err(serde::de::Error::custom(format!(
                "text exceeds maximum length of {MAX_CHARS} characters"
            )));
        }
        Ok(Self(trimmed.to_owned()))
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct BoundedText<const MAX_CHARS: usize>(String);

impl<const MAX_CHARS: usize> BoundedText<MAX_CHARS> {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de, const MAX_CHARS: usize> Deserialize<'de> for BoundedText<MAX_CHARS> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        let trimmed = raw.trim();
        if trimmed.chars().count() > MAX_CHARS {
            return Err(serde::de::Error::custom(format!(
                "text exceeds maximum length of {MAX_CHARS} characters"
            )));
        }
        Ok(Self(trimmed.to_owned()))
    }
}

pub type ShortName = NonEmptyText<128>;
pub type PostTitle = NonEmptyText<256>;
pub type MessageBody = NonEmptyText<32768>;
pub type DescriptionText = BoundedText<1024>;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct ClientReqId(String);

impl ClientReqId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for ClientReqId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        let s = raw.trim();
        if s.is_empty() || s.len() > 128 {
            return Err(serde::de::Error::custom(
                "client id length must be between 1 and 128 bytes",
            ));
        }
        if s.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(serde::de::Error::custom(
                "client id must not contain whitespace or control characters",
            ));
        }
        Ok(Self(s.to_owned()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageLimit(i64);

impl Default for PageLimit {
    fn default() -> Self {
        Self(50)
    }
}

impl PageLimit {
    pub fn get(self) -> i64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for PageLimit {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let val = i64::deserialize(deserializer)?;
        if !(1..=100).contains(&val) {
            return Err(serde::de::Error::custom(
                "limit must be between 1 and 100",
            ));
        }
        Ok(Self(val))
    }
}

/// 反序列化时自动升序排列并去重，保证下游计算幂等哈希与批量更新收件箱时天然有序无死锁。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct UniqueAgentIds(Vec<Uuid>);

impl UniqueAgentIds {
    pub fn as_slice(&self) -> &[Uuid] {
        &self.0
    }
}

impl<'de> Deserialize<'de> for UniqueAgentIds {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut ids = Vec::<Uuid>::deserialize(deserializer)?;
        ids.sort_unstable();
        ids.dedup();
        if ids.len() > 100 {
            return Err(serde::de::Error::custom(
                "cannot mention more than 100 distinct agents in a single item",
            ));
        }
        Ok(Self(ids))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_rejects_empty_uppercase_and_overlong_inputs() {
        let ok: Slug = serde_json::from_str("\"openclaw-agent_01\"").unwrap();
        assert_eq!(ok.as_str(), "openclaw-agent_01");

        assert!(serde_json::from_str::<Slug>("\"\"").is_err());
        assert!(serde_json::from_str::<Slug>("\"   \"").is_err());
        assert!(serde_json::from_str::<Slug>("\"-leading-dash\"").is_err());
        assert!(serde_json::from_str::<Slug>("\"UpperCase\"").is_err());
        assert!(serde_json::from_str::<Slug>(&format!("\"{}\"", "a".repeat(65))).is_err());
    }

    #[test]
    fn non_empty_text_trims_and_enforces_char_limit() {
        let ok: NonEmptyText<5> = serde_json::from_str("\"  你好世界  \"").unwrap();
        assert_eq!(ok.as_str(), "你好世界");

        assert!(serde_json::from_str::<NonEmptyText<5>>("\"   \\n\\t  \"").is_err());
        assert!(serde_json::from_str::<NonEmptyText<5>>("\"一二三四五六\"").is_err());
    }

    #[test]
    fn client_req_id_rejects_internal_whitespace_and_overlong() {
        let ok: ClientReqId = serde_json::from_str("\"msg-2026-0001\"").unwrap();
        assert_eq!(ok.as_str(), "msg-2026-0001");

        assert!(serde_json::from_str::<ClientReqId>("\"\"").is_err());
        assert!(serde_json::from_str::<ClientReqId>("\"has space\"").is_err());
        assert!(serde_json::from_str::<ClientReqId>(&format!("\"{}\"", "x".repeat(129))).is_err());
    }

    #[test]
    fn page_limit_validates_bounds_and_defaults() {
        assert_eq!(PageLimit::default().get(), 50);
        let ok: PageLimit = serde_json::from_str("100").unwrap();
        assert_eq!(ok.get(), 100);

        assert!(serde_json::from_str::<PageLimit>("0").is_err());
        assert!(serde_json::from_str::<PageLimit>("-5").is_err());
        assert!(serde_json::from_str::<PageLimit>("101").is_err());
    }

    #[test]
    fn unique_agent_ids_sorts_and_deduplicates_at_entry() {
        let id_hi = Uuid::from_u128(0x0000_0000_0000_0000_0000_0000_0000_0009);
        let id_lo = Uuid::from_u128(0x0000_0000_0000_0000_0000_0000_0000_0002);
        let id_mid = Uuid::from_u128(0x0000_0000_0000_0000_0000_0000_0000_0005);

        let json = serde_json::to_string(&vec![id_hi, id_lo, id_hi, id_mid, id_lo]).unwrap();
        let parsed: UniqueAgentIds = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.as_slice(), &[id_lo, id_mid, id_hi]);
    }
}
