// Minimal JSON parser with correctly-rounded f64 number parsing (std parse)
// — matches JS JSON.parse float semantics exactly.
//
// Copied verbatim from native/replay-core/src/json.rs (itself from the proven
// awt-r3/native/hdastar port). replay-core keeps its json module private, so
// this crate carries its own copy. Additions over the replay-core copy:
//   - span scanners (array_element_spans / object_entry_spans) used to splice
//     RAW hyperparameter / route JSON text through unchanged (zero
//     re-serialization risk for values Rust never interprets);
//   - number writers (write_f64 / write_u64) mirroring JSON.stringify:
//     shortest round-trip decimal (Rust Display is round-trip exact),
//     NaN/Infinity -> null, -0 -> 0.

#![allow(dead_code)]

#[derive(Clone, Debug, PartialEq)]
pub enum JVal {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<JVal>),
    Obj(Vec<(String, JVal)>),
}

impl JVal {
    pub fn get(&self, key: &str) -> Option<&JVal> {
        match self {
            JVal::Obj(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            JVal::Num(n) => Some(*n),
            _ => None,
        }
    }
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            JVal::Num(n) => Some(*n as i64),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            JVal::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_arr(&self) -> Option<&Vec<JVal>> {
        match self {
            JVal::Arr(a) => Some(a),
            _ => None,
        }
    }
    pub fn as_obj(&self) -> Option<&Vec<(String, JVal)>> {
        match self {
            JVal::Obj(o) => Some(o),
            _ => None,
        }
    }
    pub fn is_null(&self) -> bool {
        matches!(self, JVal::Null)
    }
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            JVal::Bool(b) => Some(*b),
            _ => None,
        }
    }
}

pub fn parse_json(input: &[u8]) -> Result<JVal, String> {
    let mut p = Parser { s: input, i: 0 };
    p.skip_ws();
    let v = p.parse_value()?;
    p.skip_ws();
    if p.i != p.s.len() {
        return Err(format!("trailing bytes at {}", p.i));
    }
    Ok(v)
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn skip_ws(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn peek(&self) -> u8 {
        if self.i < self.s.len() {
            self.s[self.i]
        } else {
            0
        }
    }

    fn parse_value(&mut self) -> Result<JVal, String> {
        self.skip_ws();
        match self.peek() {
            b'{' => self.parse_obj(),
            b'[' => self.parse_arr(),
            b'"' => Ok(JVal::Str(self.parse_string()?)),
            b't' => self.parse_lit("true", JVal::Bool(true)),
            b'f' => self.parse_lit("false", JVal::Bool(false)),
            b'n' => self.parse_lit("null", JVal::Null),
            b'-' | b'0'..=b'9' => self.parse_num(),
            c => Err(format!("unexpected byte {} at {}", c as char, self.i)),
        }
    }

    fn parse_lit(&mut self, lit: &str, val: JVal) -> Result<JVal, String> {
        if self.s.len() >= self.i + lit.len() && &self.s[self.i..self.i + lit.len()] == lit.as_bytes()
        {
            self.i += lit.len();
            Ok(val)
        } else {
            Err(format!("invalid literal at {}", self.i))
        }
    }

    fn parse_string(&mut self) -> Result<String, String> {
        if self.peek() != b'"' {
            return Err(format!("expected string at {}", self.i));
        }
        self.i += 1;
        let mut out = String::new();
        loop {
            if self.i >= self.s.len() {
                return Err("unterminated string".to_string());
            }
            let c = self.s[self.i];
            match c {
                b'"' => {
                    self.i += 1;
                    return Ok(out);
                }
                b'\\' => {
                    self.i += 1;
                    if self.i >= self.s.len() {
                        return Err("unterminated escape".to_string());
                    }
                    let e = self.s[self.i];
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{0008}'),
                        b'f' => out.push('\u{000C}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            if self.i + 4 > self.s.len() {
                                return Err("bad \\u escape".to_string());
                            }
                            let hex = std::str::from_utf8(&self.s[self.i..self.i + 4])
                                .map_err(|_| "bad \\u escape".to_string())?;
                            let cp = u32::from_str_radix(hex, 16)
                                .map_err(|_| "bad \\u escape".to_string())?;
                            self.i += 4;
                            // surrogate pair handling
                            if (0xD800..0xDC00).contains(&cp) {
                                if self.i + 6 <= self.s.len()
                                    && self.s[self.i] == b'\\'
                                    && self.s[self.i + 1] == b'u'
                                {
                                    let hex2 =
                                        std::str::from_utf8(&self.s[self.i + 2..self.i + 6])
                                            .map_err(|_| "bad \\u escape".to_string())?;
                                    let cp2 = u32::from_str_radix(hex2, 16)
                                        .map_err(|_| "bad \\u escape".to_string())?;
                                    if (0xDC00..0xE000).contains(&cp2) {
                                        self.i += 6;
                                        let combined = 0x10000
                                            + ((cp - 0xD800) << 10)
                                            + (cp2 - 0xDC00);
                                        out.push(
                                            char::from_u32(combined)
                                                .ok_or("bad surrogate pair")?,
                                        );
                                        continue;
                                    }
                                }
                                return Err("lone high surrogate".to_string());
                            }
                            out.push(char::from_u32(cp).unwrap_or('\u{FFFD}'));
                        }
                        _ => return Err(format!("bad escape \\{} at {}", e as char, self.i)),
                    }
                }
                _ => {
                    // raw UTF-8 byte(s)
                    let start = self.i;
                    self.i += 1;
                    while self.i < self.s.len() && (self.s[self.i] & 0xC0) == 0x80 {
                        self.i += 1;
                    }
                    let chunk = std::str::from_utf8(&self.s[start..self.i])
                        .map_err(|_| "invalid utf-8 in string".to_string())?;
                    out.push_str(chunk);
                }
            }
        }
    }

    fn parse_num(&mut self) -> Result<JVal, String> {
        let start = self.i;
        if self.peek() == b'-' {
            self.i += 1;
        }
        while self.i < self.s.len()
            && matches!(self.s[self.i], b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-')
        {
            self.i += 1;
        }
        let text = std::str::from_utf8(&self.s[start..self.i]).map_err(|_| "bad number")?;
        text.parse::<f64>()
            .map(JVal::Num)
            .map_err(|_| format!("invalid number '{}' at {}", text, start))
    }

    fn parse_obj(&mut self) -> Result<JVal, String> {
        self.i += 1; // {
        let mut entries = Vec::new();
        self.skip_ws();
        if self.peek() == b'}' {
            self.i += 1;
            return Ok(JVal::Obj(entries));
        }
        loop {
            self.skip_ws();
            let key = self.parse_string()?;
            self.skip_ws();
            if self.peek() != b':' {
                return Err(format!("expected ':' at {}", self.i));
            }
            self.i += 1;
            let val = self.parse_value()?;
            entries.push((key, val));
            self.skip_ws();
            match self.peek() {
                b',' => {
                    self.i += 1;
                }
                b'}' => {
                    self.i += 1;
                    return Ok(JVal::Obj(entries));
                }
                c => return Err(format!("expected ',' or '}}' got {} at {}", c as char, self.i)),
            }
        }
    }

    fn parse_arr(&mut self) -> Result<JVal, String> {
        self.i += 1; // [
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == b']' {
            self.i += 1;
            return Ok(JVal::Arr(items));
        }
        loop {
            let val = self.parse_value()?;
            items.push(val);
            self.skip_ws();
            match self.peek() {
                b',' => {
                    self.i += 1;
                }
                b']' => {
                    self.i += 1;
                    return Ok(JVal::Arr(items));
                }
                c => return Err(format!("expected ',' or ']' got {} at {}", c as char, self.i)),
            }
        }
    }
}

// ---------- Raw-span scanners (additions for portfolio-core) ----------

/// Byte spans (start, end) of the top-level elements of a JSON array. The
/// input must be exactly one array value (leading/trailing whitespace ok).
/// Spans are trimmed to the value text, so `&bytes[start..end]` can be
/// spliced verbatim into another JSON document.
pub fn array_element_spans(bytes: &[u8]) -> Result<Vec<(usize, usize)>, String> {
    let mut p = Parser { s: bytes, i: 0 };
    p.skip_ws();
    if p.peek() != b'[' {
        return Err(format!("expected array at {}", p.i));
    }
    p.i += 1;
    let mut out = Vec::new();
    p.skip_ws();
    if p.peek() == b']' {
        p.i += 1;
    } else {
        loop {
            p.skip_ws();
            let start = p.i;
            p.parse_value()?; // validated + skipped; value discarded
            out.push((start, p.i));
            p.skip_ws();
            match p.peek() {
                b',' => {
                    p.i += 1;
                }
                b']' => {
                    p.i += 1;
                    break;
                }
                c => {
                    return Err(format!("expected ',' or ']' got {} at {}", c as char, p.i));
                }
            }
        }
    }
    p.skip_ws();
    if p.i != bytes.len() {
        return Err(format!("trailing bytes at {}", p.i));
    }
    Ok(out)
}

/// (key, value byte span) pairs for the top-level entries of a JSON object.
/// The input must be exactly one object value.
pub fn object_entry_spans(bytes: &[u8]) -> Result<Vec<(String, (usize, usize))>, String> {
    let mut p = Parser { s: bytes, i: 0 };
    p.skip_ws();
    if p.peek() != b'{' {
        return Err(format!("expected object at {}", p.i));
    }
    p.i += 1;
    let mut out = Vec::new();
    p.skip_ws();
    if p.peek() == b'}' {
        p.i += 1;
    } else {
        loop {
            p.skip_ws();
            let key = p.parse_string()?;
            p.skip_ws();
            if p.peek() != b':' {
                return Err(format!("expected ':' at {}", p.i));
            }
            p.i += 1;
            p.skip_ws();
            let start = p.i;
            p.parse_value()?;
            out.push((key, (start, p.i)));
            p.skip_ws();
            match p.peek() {
                b',' => {
                    p.i += 1;
                }
                b'}' => {
                    p.i += 1;
                    break;
                }
                c => {
                    return Err(format!("expected ',' or '}}' got {} at {}", c as char, p.i));
                }
            }
        }
    }
    p.skip_ws();
    if p.i != bytes.len() {
        return Err(format!("trailing bytes at {}", p.i));
    }
    Ok(out)
}

// ---------- Writers (JS JSON.stringify semantics) ----------

pub fn write_json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// JSON.stringify number semantics: NaN/Infinity -> null, -0 -> 0, otherwise
/// Rust's Display (shortest round-trip decimal — parses back to the identical
/// f64, which is all downstream deep-equality compares; JS may pick exponent
/// notation for the same value, but both texts parse to the same number).
pub fn write_f64(out: &mut String, x: f64) {
    if !x.is_finite() {
        out.push_str("null");
    } else if x == 0.0 {
        out.push('0');
    } else {
        out.push_str(&format!("{}", x));
    }
}

pub fn write_u64(out: &mut String, x: u64) {
    out.push_str(&format!("{}", x));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spans_roundtrip() {
        let src = br#" { "hps" : [ {"A":1}, 2 , [3,"x"] ] , "n": null } "#;
        let entries = object_entry_spans(src).unwrap();
        assert_eq!(entries.len(), 2);
        let (k, (s, e)) = &entries[0];
        assert_eq!(k, "hps");
        let arr = &src[*s..*e];
        let el = array_element_spans(arr).unwrap();
        assert_eq!(el.len(), 3);
        assert_eq!(&arr[el[0].0..el[0].1], br#"{"A":1}"#);
        assert_eq!(&arr[el[1].0..el[1].1], b"2");
        assert_eq!(&arr[el[2].0..el[2].1], br#"[3,"x"]"#);
    }

    #[test]
    fn f64_writer_js_forms() {
        let mut s = String::new();
        write_f64(&mut s, 2.0);
        s.push(',');
        write_f64(&mut s, 0.1);
        s.push(',');
        write_f64(&mut s, -0.0);
        s.push(',');
        write_f64(&mut s, f64::NAN);
        assert_eq!(s, "2,0.1,0,null");
    }
}
