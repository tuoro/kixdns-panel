//! protobuf 的线格式，只读不写：GeoSite 分类和 `GeoIP` 地区都是 `V2Ray` 的 protobuf 文件，用不着整个 prost
//! The protobuf wire format, read only: the `GeoSite` catalog and the `GeoIP` regions both read `V2Ray`'s protobuf files,
//! which do not need the whole of prost

/// 一个字段的值：变长整数照读出来，带长度的给出那段字节，定长的跳过
/// A field's value: a varint as read, a length-delimited field's bytes, a fixed-width one skipped
pub(crate) enum Value<'a> {
    Number(u64),
    Fixed,
    Bytes(&'a [u8]),
}

/// protobuf 的字段，一个一个读出来；越界、截断和不认识的线型都报错，不会读到别处去
/// protobuf fields one at a time; running past the end, truncation and unknown wire types are errors
pub(crate) struct Fields<'a> {
    data: &'a [u8],
    position: usize,
    failed: bool,
}

impl<'a> Fields<'a> {
    pub(crate) fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            position: 0,
            failed: false,
        }
    }

    fn varint(&mut self) -> Result<u64, String> {
        let mut value = 0_u64;
        for shift in (0..64).step_by(7) {
            let byte = *self.data.get(self.position).ok_or("数字在文件结尾处断开")?;
            self.position += 1;
            value |= u64::from(byte & 0x7f) << shift;
            if byte < 0x80 {
                return Ok(value);
            }
        }
        Err("数字太长".to_owned())
    }

    fn skip(&mut self, length: usize) -> Result<&'a [u8], String> {
        let end = self
            .position
            .checked_add(length)
            .filter(|end| *end <= self.data.len())
            .ok_or("内容超出了文件长度")?;
        let bytes = &self.data[self.position..end];
        self.position = end;
        Ok(bytes)
    }

    fn next_field(&mut self) -> Result<(u64, Value<'a>), String> {
        let key = self.varint()?;
        let number = key >> 3;
        match key & 7 {
            0 => self.varint().map(|value| (number, Value::Number(value))),
            1 => self.skip(8).map(|_| (number, Value::Fixed)),
            2 => {
                let length = usize::try_from(self.varint()?).map_err(|_| "长度太大")?;
                self.skip(length).map(|bytes| (number, Value::Bytes(bytes)))
            }
            5 => self.skip(4).map(|_| (number, Value::Fixed)),
            wire => Err(format!("不认识的字段类型 {wire}")),
        }
    }
}

impl<'a> Iterator for Fields<'a> {
    type Item = Result<(u64, Value<'a>), String>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.failed || self.position >= self.data.len() {
            return None;
        }
        let field = self.next_field();
        self.failed = field.is_err();
        Some(field)
    }
}

/// 测试里拼 protobuf 用 / Builds protobuf bytes for tests
#[cfg(test)]
pub(crate) mod test_data {
    pub(crate) fn varint(mut value: u64) -> Vec<u8> {
        let mut bytes = Vec::new();
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                bytes.push(byte);
                return bytes;
            }
            bytes.push(byte | 0x80);
        }
    }

    pub(crate) fn bytes_field(number: u64, payload: &[u8]) -> Vec<u8> {
        let mut field = varint(number << 3 | 2);
        field.extend(varint(payload.len() as u64));
        field.extend_from_slice(payload);
        field
    }
}
