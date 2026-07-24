fn main() {
    let input = std::fs::read("/tmp/a01-input-001.json").unwrap();
    let mut out = vec![0u8; 64 * 1024 * 1024];
    for _ in 0..30 {
        let n = hdastar::a01_solve(input.as_ptr(), input.len(), out.as_mut_ptr(), out.len());
        assert!(n > 0);
    }
    eprintln!("done");
}
