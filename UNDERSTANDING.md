# AMBIT Microprogram Simulator - Understanding

## Architecture Overview
- **DRAM-based in-memory computing**: Operations activate DRAM rows to perform computation
- **Vertical layout**: Each bit of an operand is stored in a different row, same column

## Register Types
- **I0, I1, ...** - Input operands (vertical layout, each bit in different row)
- **O0, O1, ...** - Output operands
- **T0, T1, ...** - Designated rows (temporary storage)
- **S0, S1, ...** - Scratch registers
- **DCC0, DCC1** - Dual-contact cells for negation
- **C0, C1** - Constants (all 0s, all 1s)

## Instruction Set

### AAP (ACTIVATE-ACTIVATE-PRECHARGE)
- Default behavior: **Row copy** - copies source row to destination row
- When using a **B-group address** (B12-B15): triggers **triple-row activation** and computes **MAJ3 (majority of 3)**
- Syntax variants:
  - `AAP I0 T1` - copy I0 to T1
  - `AAP [T0, T1, T2] O1` - MAJ3 of T0, T1, T2 → O1
  - `AAP C0 [T2, T3]` - MAJ3 with C0 (constant 0) as one input
  - `AAP I0 ~DCC0` - copy I0 to DCC0 negated

### AP (ACTIVATE-PRECHARGE)
- Always performs **MAJ3 (majority of 3)** operation
- Takes 3 input rows and computes majority: (a&b) | (a&c) | (b&c)
- Syntax:
  - `AP [DCC0, T1, T2]` - MAJ3 of DCC0, T1, T2

## Key Distinction
| Instruction | Default Operation | With B-group Address |
|-------------|-------------------|---------------------|
| AAP | Row copy | MAJ3 (triple-row activation) |
| AP | MAJ3 | MAJ3 |

## Programs
- **abs4-abs64**: Absolute value computation
- **bitcount4-bitcount64**: Population count (number of 1 bits)

## Verification
The Python verifier (`verify_program.py`) emulates these instructions and tests against expected outputs.
