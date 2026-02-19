# AMBIT Microprogram Simulator - Status Report

## Current Status

### Working:
- Web visualizer with packed vertical data layout
- Step-by-step execution with visual feedback
- Support for array inputs (e.g., `[5,1,2,3]` computes 4 values in parallel across 8 columns)
- Input parsing (decimal, hex `0xFF`, arrays)
- DRAM-style memory display
- Python verification scripts (verify_program.py, verify_structure.py)

### Data Layout (Correct):
- **Vertical/Packed Layout**: Each column holds one complete operand
- Example: Input `[5, 1, 2, 3]` (4-bit values):
  - I0 = [1, 1, 0, 1, 0, 0, 0, 0] (LSB of each value)
  - I1 = [0, 0, 1, 1, 0, 0, 0, 0]
  - I2 = [1, 0, 0, 0, 0, 0, 0, 0]
  - I3 = [0, 0, 0, 0, 0, 0, 0, 0] (MSB/sign bit)

### Known Issues:
- **Microprograms are buggy**: abs4/abs8/etc. fail verification
  - abs4 with input 5 (0101) produces 1100 instead of 0101
  - Root cause: Microprograms don't correctly implement absolute value logic
  - The logic network from mockturtle IS correct (verified separately)
  - Issue: Either microprogram generation is buggy or instruction semantics are misinterpreted

### Files:
- `visualize_program.html` - Interactive web visualizer
- `verify_program.py` - Python emulator and verifier
- `verify_structure.py` - Structure checker
- `programs/*.txt` - Microprograms (currently buggy)

### Next Steps:
1. Fix or regenerate the microprograms to correctly implement abs/bitcount
2. Verify instruction semantics match AMBIT paper
3. Add more test cases and validation
