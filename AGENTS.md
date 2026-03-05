# AGENTS.md - PIM Microprogram Simulator

## Project Overview

This is a web-based visualizer and verifier for AMBIT microprograms. The project contains:
- `visualize_program.html` - Interactive web-based visualizer (HTML/CSS/JS)
- `verify_program.py` - Python emulator for AAP/AP instructions
- `verify_structure.py` - Structural verification of programs
- `programs/` - Sample microprograms (abs4-abs64, bitcount4-bitcount64)

## Build, Lint, and Test Commands

### Running the Web Visualizer
```bash
python3 -m http.server 8000
```
Then open http://localhost:8000/visualize_program.html

### Running Verification - Single Test
```bash
# Verify a single program
python3 verify_program.py programs/abs4.txt

# Verify with specific test count
python3 verify_program.py programs/abs4.txt --num-tests 10

# Verify with specific function
python3 verify_program.py programs/abs8.txt --function abs --num-tests 50
```

### Running Verification - Multiple Tests
```bash
# All abs programs
python3 verify_program.py programs/abs*.txt

# All bitcount programs  
python3 verify_program.py programs/bitcount*.txt

# Auto-detect function from filename
python3 verify_program.py programs/abs4.txt --function auto
```

### Structural Verification
```bash
# All programs
python3 verify_structure.py

# Specific programs
python3 verify_structure.py programs/abs4.txt programs/bitcount4.txt
```

### Test Options
- `--function`: Choose `abs`, `bitcount`, or `auto` (auto-detect from filename)
- `--num-tests`: Number of test cases (default: 100)
- `--row-size`: Row size in bytes (default: 8192)

### Syntax Checking
```bash
# Python syntax check
python3 -m py_compile verify_program.py
python3 -m py_compile verify_structure.py

# HTML linting (requires htmlhint)
npx htmlhint visualize_program.html
```

## Code Style Guidelines

### General - Python
- Language: Python 3
- No external dependencies - uses only standard library
- Run scripts with `python3` (not `python`)

### General - JavaScript/HTML
- Use vanilla JavaScript (no frameworks)
- Keep JavaScript inline in HTML for the visualizer
- Use semantic HTML elements
- CSS: use inline styles for simplicity or add to `<style>` block

### Type Hints (Python)
- Use type hints for all function arguments and return values
- Use `typing` module for complex types: `List`, `Dict`, `Optional`, `Tuple`
```python
def run_program(self, program: Program, input_values: List[int]) -> Optional[int]:
```

### Naming Conventions (Python)
- Classes: `PascalCase` (e.g., `MemoryConfig`, `AAPInstruction`)
- Functions/methods: `snake_case` (e.g., `run_program`, `parse_file`)
- Variables: `snake_case` (e.g., `input_values`, `bitwidth`)
- Constants: `UPPER_SNAKE_CASE` (e.g., `DEFAULT_ROW_SIZE`)
- Private methods: prefix with `_` (e.g., `_parse`, `_analyze_args`)

### Dataclasses (Python)
- Use `@dataclass` decorator for simple data containers
- Define fields with type annotations and default values
```python
@dataclass
class AAPInstruction(Instruction):
    args: List[str]

    def __str__(self):
        return f"AAP {' '.join(self.args)}"
```

### Imports (Python)
- Standard library imports first, then third-party (none in this project)
- Group by: builtins → typing → dataclasses → other stdlib
- Use explicit imports (avoid `from x import *`)
```python
import re
import sys
import os
import argparse
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple
from collections import defaultdict
```

### Formatting (Python)
- 4-space indentation (no tabs)
- Maximum line length: 100 characters (soft limit)
- Add spaces around operators: `a + b`, not `a+b`
- Use spaces after commas: `args[0], args[1]`, not `args[0],args[1]`
- Use blank lines between class definitions and major sections

### Error Handling (Python)
- Use specific exception types when possible
- Include informative error messages
- Use `try/except` sparingly and catch specific exceptions
```python
try:
    idx = int(dest[1:])
    self.registers[f"O{idx}"] = result
except ValueError:
    pass  # Ignore invalid operand format
```

### Documentation (Python)
- Module-level docstrings for main files
- Class docstrings for public classes
- Keep comments brief and meaningful
- Document complex logic with inline comments

### File Organization (Python)
- Main entry point at bottom: `if __name__ == "__main__":`
- Classes before functions that use them
- Related functions grouped together

## AMBIT Architecture Reference

### Vertical Data Layout
In AMBIT, data is stored vertically in the DRAM array:
- Each **bit** of a value occupies a separate **row** in the same column
- Column index corresponds to the **bit position** (bit 0 = LSB, bit 1 = next, etc.)
- This enables bit-parallel operations across rows

Example for 4-bit value `5` (binary `0101`) stored in column 0:
```
Row \ Col | Col 0
----------+-------
I0 (bit0) |   1    ← LSB
I0 (bit1) |   0
I0 (bit2) |   1
I0 (bit3) |   0    ← MSB
```

For multiple inputs (e.g., abs(I0, I1)), each input uses a separate column:
```
Row \ Col | Col 0 | Col 1
----------+-------+-------
I0 (bit0) |   1   |   0
I0 (bit1) |   0   |   1
...
I1 (bit0) |   0   |   1
```

### Register Types
- **I0, I1, ...** - Input operands (vertical layout, each bit in different row)
- **O0, O1, ...** - Output operands
- **T0, T1, ...** - Designated rows (temporary storage)
- **S0, S1, ...** - Scratch registers
- **DCC0, DCC1** - Dual-contact cells for negation
- **C0, C1** - Constants (all 0s, all 1s)

### Instruction Set

#### AAP (ACTIVATE-ACTIVATE-PRECHARGE)
- Default behavior: **Row copy** - copies source row to destination row
- When using a **B-group address** (B12-B15): triggers **triple-row activation** and computes **MAJ3**
- Syntax variants:
  - `AAP I0 T1` - copy I0 to T1
  - `AAP [T0, T1, T2] O1` - MAJ3 of T0, T1, T2 → O1
  - `AAP C0 [T2, T3]` - MAJ3 with C0 (constant 0) as one input

#### AP (ACTIVATE-PRECHARGE)
- Always performs **MAJ3 (majority of 3)** operation
- Takes 3 input rows and computes majority: (a&b) | (a&c) | (b&c)
- Syntax: `AP [DCC0, T1, T2]` - MAJ3 of DCC0, T1, T2

## Common Tasks

### Adding a New Verification Function
1. Add function to `verify_program.py`
2. Follow naming: `verify_<function_name>`
3. Accept `bitwidth`, `program`, and optional `num_tests` parameters
4. Return `(passed, failed)` tuple
5. Add to `main()` function's function detection logic

### Adding a New Program Format
1. Update `Program.parse_file()` in `verify_program.py`
2. Update `ProgramAnalyzer` in `verify_structure.py` if needed
3. Add test cases to verify correctness

### Debugging the Visualizer
1. Open browser DevTools (F12)
2. Check Console for JavaScript errors
3. Use `console.log()` for debugging
4. Ensure HTTP server is running: `python3 -m http.server 8000`

## File Structure
```
/home/alex/Documents/Studium/Sem7/hauptseminar/ambit_microprogram_simulator/
├── AGENTS.md                    # This file
├── UNDERSTANDING.md             # Architecture notes
├── README.md                    # Project README
├── visualize_program.html       # Web visualizer
├── verify_program.py            # Python emulator/verifier
├── verify_structure.py          # Structural verifier
├── package.json                 # Node dependencies (htmlhint, eslint)
├── programs/                    # Sample microprograms
│   ├── abs4.txt - abs64.txt    # Absolute value programs
│   └── bitcount4.txt - bitcount64.txt  # Population count programs
└── papers/                     # Reference papers (if available)
```
