# PIM Microprogram Simulator

A web-based visualizer and verifier for AMBIT microprograms.

- [ ] ReRAM: stateful logic (2) non-stateful)

## Files

- `visualize_program.html` - Interactive web-based visualizer
- `verify_program.py` - Python emulator for AAP/AP instructions
- `verify_structure.py` - Structural verification of programs
- `programs/` - Sample microprograms (abs4-abs64, bitcount4-bitcount64)

## Usage

### Web Visualizer

Run a local web server:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000/visualize_program.html

### Python Verifier

```bash
python3 verify_program.py programs/abs4.txt
python3 verify_structure.py
```

## AMBIT Architecture

- **I0, I1, ...** - Input operands (vertical layout, each bit in different row)
- **O0, O1, ...** - Output operands
- **T0, T1, ...** - Designated rows (temporary storage)
- **S0, S1, ...** - Scratch registers
- **DCC0, DCC1** - Dual-contact cells for negation
- **C0, C1** - Constants (all 0s, all 1s)

### AAP Instruction
ACTIVATE-ACTIVATE-PRECHARGE: Copies source to destination

### AP Instruction
ACTIVATE-PRECHARGE: Used for majority operations
