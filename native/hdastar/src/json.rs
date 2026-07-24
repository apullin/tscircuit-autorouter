// Minimal JSON parser/serializer with correctly-rounded f64 (std parse) and
// shortest-roundtrip printing (ryu) — matches JS JSON.parse/stringify float
// semantics exactly, unlike serde_json's number conversion (observed 1-ulp
// deviations, e.g. 3.6948275862068964).

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

// ---------- Serializer (JS JSON.stringify semantics) ----------

pub fn write_f64(out: &mut String, v: f64) {
    if v.is_nan() || v.is_infinite() {
        out.push_str("null");
        return;
    }
    if v == 0.0 {
        // JS prints -0 as 0
        out.push('0');
        return;
    }
    // integers without fraction: JS prints without ".0"; ryu matches
    let mut buf = ryu::Buffer::new();
    out.push_str(buf.format(v));
}

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

pub fn write_jval(out: &mut String, v: &JVal) {
    match v {
        JVal::Null => out.push_str("null"),
        JVal::Bool(true) => out.push_str("true"),
        JVal::Bool(false) => out.push_str("false"),
        JVal::Num(n) => write_f64(out, *n),
        JVal::Str(s) => write_json_string(out, s),
        JVal::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_jval(out, item);
            }
            out.push(']');
        }
        JVal::Obj(entries) => {
            out.push('{');
            for (i, (k, val)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json_string(out, k);
                out.push(':');
                write_jval(out, val);
            }
            out.push('}');
        }
    }
}
