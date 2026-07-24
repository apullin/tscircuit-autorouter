fn main() {
    let text = "{\"y\": 3.6948275862068964, \"x\": -2.65}";
    let v: serde_json::Value = serde_json::from_str(text).unwrap();
    let y = &v["y"];
    println!("as_f64 bits: {:x}", y.as_f64().unwrap().to_bits());
    println!("reserialize: {}", serde_json::to_string(&v).unwrap());
    let n: f64 = serde_json::from_value(y.clone()).unwrap();
    println!("from_value bits: {:x}", n.to_bits());
}
