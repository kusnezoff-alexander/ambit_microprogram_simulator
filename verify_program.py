#!/usr/bin/env python3
"""
Verifier for AMBIT microprograms.
Simulates AAP/AP instructions and verifies correctness for abs and bitcount functions.
"""

import re
import sys
import os
import argparse
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple
from collections import defaultdict


@dataclass
class MemoryConfig:
    row_size_bytes: int = 8192  # 8KiB default
    word_size_bits: int = 1  # vertical layout: 1 bit per cell

    @property
    def bits_per_row(self) -> int:
        return self.row_size_bytes * 8

    @property
    def cols_per_row(self) -> int:
        return self.bits_per_row // self.word_size_bits


@dataclass
class Memory:
    config: MemoryConfig
    rows: List[List[Optional[int]]] = field(default_factory=list)

    def __post_init__(self):
        self.add_row()

    def add_row(self):
        self.rows.append([None] * self.config.cols_per_row)

    def read(self, row: int, col: int) -> Optional[int]:
        if row >= len(self.rows):
            return None
        return self.rows[row][col]

    def write(self, row: int, col: int, value: Optional[int]):
        while row >= len(self.rows):
            self.add_row()
        self.rows[row][col] = value

    def allocate_var(
        self, name: str, num_bits: int, row: int = 0
    ) -> List[Tuple[int, int]]:
        """Allocate vertical bits starting at given row, return list of (row, col) positions."""
        positions = []
        bits_per_col = (
            self.config.bits_per_row
        )  # bits that fit in one column (one per row)

        col = 0
        bits_placed = 0
        while bits_placed < num_bits:
            if col >= self.config.cols_per_row:
                col = 0
                row += 1

            # In vertical layout, we place consecutive bits in same column, different rows
            pos_row = row + bits_placed
            positions.append((pos_row, col))
            bits_placed += 1

        return positions

    def get_positions_for_input(
        self, base_row: int, bitwidth: int, input_idx: int
    ) -> List[Tuple[int, int]]:
        """Get positions for input i with given bitwidth in vertical layout."""
        # Each input is placed in a separate column (or group of columns)
        col = input_idx
        positions = []
        for b in range(bitwidth):
            row = base_row + b
            positions.append((row, col))
        return positions

    def set_input_values(self, inputs: List[int], bitwidth: int, start_row: int = 0):
        """Set input values in vertical layout."""
        for input_idx, value in enumerate(inputs):
            positions = self.get_positions_for_input(start_row, bitwidth, input_idx)
            for bit_pos, (row, col) in enumerate(positions):
                bit = (value >> bit_pos) & 1
                self.write(row, col, bit)

    def get_output_values(
        self, bitwidth: int, start_row: int = 0, num_outputs: int = 1
    ) -> List[int]:
        """Read output values in vertical layout."""
        results = []
        for out_idx in range(num_outputs):
            col = out_idx  # Outputs start after inputs
            value = 0
            for bit_pos in range(bitwidth):
                row = start_row + bit_pos
                bit = self.read(row, col)
                if bit is None:
                    bit = 0
                value |= bit << bit_pos
            results.append(value)
        return results


@dataclass
class Instruction:
    pass


@dataclass
class AAPInstruction(Instruction):
    """AAP (Allocate and Compute) instruction."""

    args: List[str]

    def __str__(self):
        return f"AAP {' '.join(self.args)}"


@dataclass
class APInstruction(Instruction):
    """AP (Compute) instruction."""

    args: List[str]

    def __str__(self):
        return f"AP {' '.join(self.args)}"


class Program:
    def __init__(
        self,
        instructions: List[Instruction],
        num_inputs: int,
        num_outputs: int,
        bitwidth: int,
    ):
        self.instructions = instructions
        self.num_inputs = num_inputs
        self.num_outputs = num_outputs
        self.bitwidth = bitwidth

    @classmethod
    def parse_file(cls, filepath: str) -> "Program":
        """Parse AAP/AP program from file."""
        instructions = []
        num_inputs = 0
        num_outputs = 0
        bitwidth = 0

        with open(filepath, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue

                # Parse AAP instruction
                elif line.startswith("AAP "):
                    # Need to handle bracketed expressions carefully
                    rest = line[4:]
                    args = []
                    current = ""
                    in_bracket = False
                    for ch in rest:
                        if ch == "[":
                            in_bracket = True
                            current += ch
                        elif ch == "]":
                            in_bracket = False
                            current += ch
                        elif ch == " " and not in_bracket:
                            if current:
                                args.append(current)
                                current = ""
                        else:
                            current += ch
                    if current:
                        args.append(current)

                    instructions.append(AAPInstruction(args))

                    # Track inputs
                    for arg in args:
                        if arg.startswith("I"):
                            try:
                                idx = int(arg[1:])
                                num_inputs = max(num_inputs, idx + 1)
                            except ValueError:
                                pass

                        # Track outputs
                        if arg.startswith("O"):
                            try:
                                idx = int(arg[1:])
                                num_outputs = max(num_outputs, idx + 1)
                            except ValueError:
                                pass

                # Parse AP instruction
                elif line.startswith("AP "):
                    # Need to handle bracketed expressions carefully
                    rest = line[3:]
                    args = []
                    current = ""
                    in_bracket = False
                    for ch in rest:
                        if ch == "[":
                            in_bracket = True
                            current += ch
                        elif ch == "]":
                            in_bracket = False
                            current += ch
                        elif ch == " " and not in_bracket:
                            if current:
                                args.append(current)
                                current = ""
                        else:
                            current += ch
                    if current:
                        args.append(current)

                    instructions.append(APInstruction(args))

                    for arg in args:
                        if arg.startswith("O"):
                            try:
                                idx = int(arg[1:])
                                num_outputs = max(num_outputs, idx + 1)
                            except ValueError:
                                pass

        # Infer bitwidth from filename
        match = re.search(r"(\d+)\.txt$", filepath)
        if match:
            bitwidth = int(match.group(1))

        return cls(instructions, num_inputs, num_outputs, bitwidth)


class Emulator:
    def __init__(self, config: MemoryConfig = None):
        self.config = config or MemoryConfig()
        self.memory = Memory(self.config)
        self.registers: Dict[str, Optional[int]] = defaultdict(lambda: None)
        self.next_temp_idx = 0

    def parse_operand(self, op: str) -> Optional[Tuple[str, int]]:
        """Parse operand like I0, T1, S2, O3, C0, DCC0, DCC1."""
        if not op:
            return None

        # Handle negation
        negated = False
        if op.startswith("~"):
            negated = True
            op = op[1:]

        # Handle list notation like [T2, T3]
        if op.startswith("["):
            return None  # List operands handled specially

        # Parse operand type and index
        if len(op) >= 2:
            prefix = op[0]
            try:
                idx = int(op[1:])
                return (prefix, idx, negated)
            except ValueError:
                pass
        elif op == "C0":
            return ("C", 0, negated)
        elif op == "C1":
            return ("C", 1, negated)

        return None

    def get_value(self, op: str) -> Optional[int]:
        """Get value of an operand."""
        op = op.strip()

        # Handle negation
        if op.startswith("~"):
            inner = self.get_value(op[1:])
            if inner is None:
                return None
            return None  # Return None to indicate we need to compute negation

        # Immediate values
        if op.startswith("I"):
            return ("I", int(op[1:]), False)
        elif op.startswith("T"):
            return ("T", int(op[1:]), False)
        elif op.startswith("S"):
            return ("S", int(op[1:]), False)
        elif op.startswith("O"):
            return ("O", int(op[1:]), False)
        elif op == "C0":
            return ("C", 0, False)
        elif op == "C1":
            return ("C", 1, False)
        elif op.startswith("DCC"):
            return ("DCC", int(op[3:]), False)

        return None

    def run_aap(
        self, args: List[str], input_values: List[int]
    ) -> Dict[str, Optional[int]]:
        """Run AAP (ACTIVATE-ACTIVATE-PRECHARGE) instruction.

        Based on Ambit paper:
        - AAP (addr1, addr2): ACTIVATE addr1; ACTIVATE addr2; PRECHARGE
        - If addr2 triggers triple-row activation (B12-B15), computes majority
        - Otherwise, just copies addr1 to addr2

        In our simplified format:
        - AAP [T0, T1, T2] O: majority(T0, T1, T2) -> O
        - AAP I0 O: copy I0 -> O
        """

        if len(args) < 2:
            return {}

        # Find destination and sources
        dest_args = []
        src_args = []
        majority_args = []  # For bracketed [T0, T1, T2] format

        # Check if any arg is bracketed (indicates majority operation)
        # Two patterns:
        # 1. AAP [T0, T1, T2] O1 - bracketed first, dest second
        # 2. AAP C0 [T2, T3] - src first, bracketed second (dest implicit)

        bracketed_idx = -1
        for i, arg in enumerate(args):
            if arg.startswith("[") and arg.endswith("]"):
                bracketed_idx = i
                inner = arg[1:-1]
                majority_args = [p.strip() for p in inner.split(",")]
                break

        if bracketed_idx >= 0:
            # Majority operation
            # Destination is the non-bracketed arg
            if bracketed_idx == len(args) - 1:
                # Bracketed at end: AAP src [T0 T1 T2]
                dest_args = [args[0]] if args[0] not in majority_args else []
                src_args = args[1:-1] if len(args) > 2 else []
            else:
                # Bracketed at beginning: AAP [T0 T1 T2] dest
                dest_args = [args[-1]] if not args[-1].startswith("[") else []
                src_args = args[1:-1] if len(args) > 2 else []
        else:
            # Simple copy: source -> dest
            dest_args = [args[-1]]
            src_args = args[:-1]

        # Get source values (handle negation in source args)
        src_values = []
        for src in src_args:
            # Check if source is negated
            negated = src.startswith("~")
            if negated:
                src = src[1:]

            val = self.get_operand_value(src, input_values)
            if val is None:
                val = 0
            if negated:
                val = 1 - val  # Negate
            src_values.append(val)

        # Compute result
        if majority_args:
            # Majority: (a&b) | (a&c) | (b&c)
            vals = []
            for p in majority_args:
                v = self.get_operand_value(p, input_values)
                if v is None:
                    v = 0
                vals.append(v)

            # Need 3 values for majority - pad with 0 if needed
            while len(vals) < 3:
                vals.append(0)

            a, b, c = vals[0], vals[1], vals[2]
            result = (a & b) | (a & c) | (b & c)
        else:
            # Simple copy: just use the first source value
            result = src_values[0] if src_values else 0

        # Write to destinations (handle negation)
        for dest in dest_args:
            # Check for negation
            negated = dest.startswith("~")
            if negated:
                dest = dest[1:]
                result = 1 - result  # Negate result

            if dest.startswith("O"):
                try:
                    idx = int(dest[1:])
                    self.registers[f"O{idx}"] = result
                except:
                    pass
            elif dest.startswith("S"):
                try:
                    idx = int(dest[1:])
                    self.registers[f"S{idx}"] = result
                except:
                    pass
            elif dest.startswith("DCC"):
                try:
                    idx = int(dest[3:])
                    self.registers[f"DCC{idx}"] = result
                except:
                    pass
            elif dest.startswith("T"):
                try:
                    idx = int(dest[1:])
                    self.registers[f"T{idx}"] = result
                except:
                    pass

        return {dest: result for dest in dest_args}

    def get_operand_value(self, op: str, input_values: List[int]) -> Optional[int]:
        """Get value of a single operand."""
        op = op.strip()

        # Handle negation
        if op.startswith("~"):
            inner = self.get_operand_value(op[1:], input_values)
            if inner is None:
                return None
            return 1 - inner  # Negate

        # Handle bracketed expressions like [T0, T1, T2] - compute AND of all
        if op.startswith("[") and op.endswith("]"):
            inner = op[1:-1]  # Remove brackets
            parts = [p.strip() for p in inner.split(",")]
            result = None
            for p in parts:
                if p:
                    val = self.get_single_operand_value(p, input_values)
                    if val is None:
                        return None
                    if result is None:
                        result = val
                    else:
                        result = result & val
            return result

        return self.get_single_operand_value(op, input_values)

    def get_single_operand_value(
        self, op: str, input_values: List[int]
    ) -> Optional[int]:
        """Get value of a single (non-bracketed) operand."""
        op = op.strip()

        # Handle negation
        if op.startswith("~"):
            inner = self.get_single_operand_value(op[1:], input_values)
            if inner is None:
                inner = 0  # Treat None as 0 for negation
            return 1 - inner

        if op.startswith("I"):
            idx = int(op[1:])
            if idx < len(input_values):
                return input_values[idx]
        elif op.startswith("T"):
            idx = int(op[1:])
            return self.registers.get(f"T{idx}", None)
        elif op.startswith("S"):
            idx = int(op[1:])
            return self.registers.get(f"S{idx}", None)
        elif op == "C0":
            return 0
        elif op == "C1":
            return 1
        elif op.startswith("DCC"):
            idx = int(op[3:])
            return self.registers.get(f"DCC{idx}", None)

        return None

    def run_ap(
        self, args: List[str], input_values: List[int]
    ) -> Dict[str, Optional[int]]:
        """Run AP (Compute) instruction."""
        # Format: AP [T0, T1, T2] or AP [DCC0, T1, T2] or similar
        # This is a ternary operation: (arg1 AND arg2) OR (arg3 AND arg4) etc.

        if len(args) < 3:
            return {}

        # Parse the argument list (inside brackets)
        arg_str = " ".join(args)
        if arg_str.startswith("[") and arg_str.endswith("]"):
            inner = arg_str[1:-1]
            parts = [p.strip() for p in inner.split(",")]
        else:
            parts = args

        if len(parts) < 3:
            return {}

        # First three are inputs to the ternary MUX: [a, b, c] = a ? b : c
        # OR it's [s0, s1, s2] = majority(s0, s1, s2)

        # Get the three values
        vals = []
        for p in parts[:3]:
            val = self.get_operand_value(p, input_values)
            vals.append(val)

        # If any is None, we can't compute
        if None in vals:
            return {}

        a, b, c = vals

        # AMBIT AP is majority: (a&b) | (a&c) | (b&c)
        result = (a & b) | (a & c) | (b & c)

        # Check for output destinations (remaining args)
        if len(parts) > 3:
            # Additional destinations
            for dest in parts[3:]:
                if dest.startswith("O"):
                    # Output - would need to handle differently
                    pass
                elif dest.startswith("T"):
                    idx = int(dest[1:])
                    self.registers[f"T{idx}"] = result
                elif dest.startswith("S"):
                    idx = int(dest[1:])
                    self.registers[f"S{idx}"] = result

        return {"result": result}

    def run_program(self, program: Program, input_values: List[int]) -> Optional[int]:
        """Run a program and return the output (reconstructed from O0, O1, ...)."""
        self.registers.clear()

        for instr in program.instructions:
            if isinstance(instr, AAPInstruction):
                self.run_aap(instr.args, input_values)
            elif isinstance(instr, APInstruction):
                self.run_ap(instr.args, input_values)

        # Reconstruct output from O0, O1, O2, ... (vertical layout: O0 = LSB)
        output = 0
        for i in range(20):  # Max 20 output bits
            val = self.registers.get(f"O{i}", None)
            if val is not None and val == 1:
                output |= 1 << i

        return output if output != 0 else self.registers.get("O0", None)


def verify_abs(
    bitwidth: int, program: Program, num_tests: int = 100
) -> Tuple[int, int]:
    """Verify abs function."""
    passed = 0
    failed = 0

    emulator = Emulator()

    # Test values: include edge cases
    test_values = []

    # Edge cases
    test_values.append(0)
    test_values.append(1)
    test_values.append((1 << (bitwidth - 1)) - 1)  # Max positive
    test_values.append(1 << (bitwidth - 1))  # Min negative
    test_values.append((1 << bitwidth) - 1)  # All ones (as signed: -1)

    # Random values
    import random

    random.seed(42)
    for _ in range(num_tests - len(test_values)):
        test_values.append(random.randint(0, (1 << bitwidth) - 1))

    for val in test_values:
        # Interpret as signed
        if val >= (1 << (bitwidth - 1)):
            signed_val = val - (1 << bitwidth)
        else:
            signed_val = val

        expected = abs(signed_val)
        if expected >= 0:
            expected = expected & ((1 << bitwidth) - 1)

        # Run program - need to set up inputs properly
        # For n-bit input, create list of n bits
        input_values = [(val >> i) & 1 for i in range(bitwidth)]
        result = emulator.run_program(program, input_values)

        if result == expected:
            passed += 1
        else:
            failed += 1
            if failed <= 5:
                print(f"  FAIL: abs({val}) = expected {expected}, got {result}")

    return passed, failed


def verify_bitcount(
    bitwidth: int, program: Program, num_tests: int = 100
) -> Tuple[int, int]:
    """Verify bitcount (popcount) function."""
    passed = 0
    failed = 0

    emulator = Emulator()

    test_values = []

    # Edge cases
    test_values.append(0)
    test_values.append(1)
    test_values.append((1 << bitwidth) - 1)  # All ones
    test_values.append(0x55555555 & ((1 << bitwidth) - 1))  # Alternating 0101...
    test_values.append(0xAAAAAAAA & ((1 << bitwidth) - 1))  # Alternating 1010...

    import random

    random.seed(42)
    for _ in range(num_tests - len(test_values)):
        test_values.append(random.randint(0, (1 << bitwidth) - 1))

    for val in test_values:
        expected = bin(val).count("1")

        input_values = [val]
        result = emulator.run_program(program, input_values)

        if result == expected:
            passed += 1
        else:
            failed += 1
            if failed <= 5:
                print(f"  FAIL: bitcount({val}) = expected {expected}, got {result}")

    return passed, failed


def main():
    parser = argparse.ArgumentParser(description="Verify AMBIT microprograms")
    parser.add_argument("files", nargs="*", help="Program files to verify")
    parser.add_argument(
        "--row-size", type=int, default=8192, help="Row size in bytes (default: 8192)"
    )
    parser.add_argument(
        "--function",
        choices=["abs", "bitcount", "auto"],
        default="auto",
        help="Function to verify (auto-detect from filename)",
    )
    parser.add_argument(
        "--num-tests", type=int, default=100, help="Number of test cases"
    )
    args = parser.parse_args()

    config = MemoryConfig(row_size_bytes=args.row_size)

    if not args.files:
        # Auto-discover files in bench/
        bench_dir = "bench"
        if os.path.exists(bench_dir):
            for f in os.listdir(bench_dir):
                if f.endswith(".txt") and (
                    f.startswith("abs") or f.startswith("bitcount")
                ):
                    args.files.append(os.path.join(bench_dir, f))

    for filepath in args.files:
        filename = os.path.basename(filepath)

        # Detect function and bitwidth
        if args.function == "auto":
            name_without_ext = filename.replace(".txt", "")
            if name_without_ext.startswith("abs"):
                function = "abs"
                bitwidth = int(name_without_ext[3:])
            elif name_without_ext.startswith("bitcount"):
                function = "bitcount"
                bitwidth = int(name_without_ext[8:])
            else:
                print(f"Skipping {filename}: cannot detect function")
                continue
        else:
            function = args.function
            name_without_ext = filename.replace(".txt", "")
            if function == "abs":
                bitwidth = int(name_without_ext[3:])
            else:
                bitwidth = int(name_without_ext[8:])

        print(f"\nVerifying {filename} ({function}{bitwidth})...")

        try:
            program = Program.parse_file(filepath)
            print(f"  Loaded {len(program.instructions)} instructions")
            print(f"  Inputs: {program.num_inputs}, Outputs: {program.num_outputs}")

            if function == "abs":
                passed, failed = verify_abs(bitwidth, program, args.num_tests)
            else:
                passed, failed = verify_bitcount(bitwidth, program, args.num_tests)

            print(f"  Results: {passed} passed, {failed} failed")

            if failed == 0:
                print(f"  ✓ ALL TESTS PASSED")
            else:
                print(f"  ✗ SOME TESTS FAILED")

        except Exception as e:
            print(f"  ERROR: {e}")
            import traceback

            traceback.print_exc()


if __name__ == "__main__":
    import os

    main()
