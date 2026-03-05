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
    def __init__(self, config: MemoryConfig = None, bitwidth: int = 8):
        self.config = config or MemoryConfig()
        self.memory = Memory(self.config)
        self.registers: Dict[str, Optional[int]] = defaultdict(lambda: None)
        self.next_temp_idx = 0
        self.bitwidth = bitwidth  # Number of bits to process

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

        AAP semantics (matching visualizer):
        - AAP [T0,T1,T2] dest  -> MAJ3(T0,T1,T2) written to ALL bracketed args AND dest
        - AAP src [T2,T3]       -> copy src to all destinations in brackets (multi-row copy)
        - AAP src dest          -> simple copy
        """

        if len(args) < 2:
            return {}

        # Parse bracketed and non-bracketed args
        bracketed_args = []
        non_bracketed_args = []
        bracketed_idx = -1

        for i, arg in enumerate(args):
            if arg.startswith("[") and arg.endswith("]"):
                bracketed_idx = i
                inner = arg[1:-1]
                bracketed_args = [p.strip() for p in inner.split(",")]
            else:
                non_bracketed_args.append(arg)

        # Case 1: AAP [a,b,c] dest - MAJ3, write to all bracketed AND dest
        if len(bracketed_args) >= 3 and len(non_bracketed_args) >= 1:
            dest = non_bracketed_args[-1]  # Last non-bracketed is dest
            num_cols = self.bitwidth  # Use dynamic bitwidth

            for c in range(num_cols):  # Execute for each column (bit position)
                a = self.get_register_bit(bracketed_args[0], c, input_values)
                b = self.get_register_bit(bracketed_args[1], c, input_values)
                cc = self.get_register_bit(bracketed_args[2], c, input_values)
                result = (a & b) | (a & cc) | (b & cc)

                # Write to ALL bracketed args
                for r in bracketed_args:
                    self.set_register_bit(r, c, result, input_values)
                # Write to destination
                self.set_register_bit(dest, c, result, input_values)

            return {dest: result}

        # Case 2: AAP src [a,b] - multi-row copy (src to all bracketed)
        elif (
            len(bracketed_args) > 0
            and len(bracketed_args) < 3
            and len(non_bracketed_args) >= 1
        ):
            src = non_bracketed_args[0]
            num_cols = self.bitwidth  # Use dynamic bitwidth

            for c in range(num_cols):
                val = self.get_register_bit(src, c, input_values)
                for dest in bracketed_args:
                    self.set_register_bit(dest, c, val, input_values)

            return {bracketed_args[0]: val}

        # Case 3: AAP src dest - simple copy
        elif len(non_bracketed_args) == 2:
            src = non_bracketed_args[0]
            dest = non_bracketed_args[1]
            num_cols = self.bitwidth  # Use dynamic bitwidth

            for c in range(num_cols):
                val = self.get_register_bit(src, c, input_values)
                self.set_register_bit(dest, c, val, input_values)

            return {dest: val}

        return {}

    def get_register_bit(self, reg: str, col: int, input_values: List[int]) -> int:
        """Get a single bit from a register.

        For input registers (I): uses register index directly as bit position
        (ignores column, since inputs are stored as flat bit array)

        For other registers: uses column to select which operand (for multi-operand ops)
        """
        reg = reg.strip()
        negated = False
        if reg.startswith("~"):
            reg = reg[1:]
            negated = True

        val = self._get_register_value(reg, col, input_values)
        if val is None:
            val = 0
        if negated:
            val = 1 - val
        return val

    def _get_register_value(
        self, reg: str, col: int, input_values: List[int]
    ) -> Optional[int]:
        """Get the value of a register at a specific column.

        For input registers (I): use register index as direct bit index into flat input array.
        For other registers: use column to select which bit from the array.
        """
        if reg.startswith("I"):
            idx = int(reg[1:])
            # For input registers, use column to calculate index into flat array
            # input_values layout: [operand0_bit0, operand0_bit1, ..., operand1_bit0, ...]
            # index = col * bitwidth + idx
            actual_idx = col * self.bitwidth + idx
            if actual_idx < len(input_values):
                return input_values[actual_idx]
        elif reg.startswith("T"):
            idx = int(reg[1:])
            reg_arr = self.registers.get(f"T{idx}")
            if reg_arr is not None and isinstance(reg_arr, list) and col < len(reg_arr):
                return reg_arr[col]
            return reg_arr
        elif reg.startswith("S"):
            idx = int(reg[1:])
            reg_arr = self.registers.get(f"S{idx}")
            if reg_arr is not None and isinstance(reg_arr, list) and col < len(reg_arr):
                return reg_arr[col]
            return reg_arr
        elif reg == "C0":
            return 0
        elif reg == "C1":
            return 1
        elif reg.startswith("DCC"):
            idx = int(reg[3:])
            reg_arr = self.registers.get(f"DCC{idx}")
            if reg_arr is not None and isinstance(reg_arr, list) and col < len(reg_arr):
                return reg_arr[col]
            return reg_arr
        elif reg.startswith("O"):
            idx = int(reg[1:])
            reg_arr = self.registers.get(f"O{idx}")
            if reg_arr is not None and isinstance(reg_arr, list) and col < len(reg_arr):
                return reg_arr[col]
            return reg_arr
        return None

    def set_register_bit(self, reg: str, col: int, value: int, input_values: List[int]):
        """Set a single bit in a register at a specific column."""
        reg = reg.strip()
        negated = False
        if reg.startswith("~"):
            reg = reg[1:]
            negated = True

        if negated:
            value = 1 - value

        # Get or create register as array
        reg_key = reg
        if reg_key not in self.registers:
            self.registers[reg_key] = [None] * self.bitwidth

        # Set the bit at the specific column
        if col < len(self.registers[reg_key]):
            self.registers[reg_key][col] = value

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
        """Run AP (Compute) instruction.

        AP semantics (matching visualizer):
        - AP [T0, T1, T2]: MAJ3 in-place, writes to ALL bracketed args
        """

        # Parse bracketed args
        bracketed_args = []
        for arg in args:
            if arg.startswith("[") and arg.endswith("]"):
                inner = arg[1:-1]
                bracketed_args = [p.strip() for p in inner.split(",")]

        if len(bracketed_args) >= 3:
            num_cols = self.bitwidth  # Use dynamic bitwidth
            for c in range(num_cols):
                a = self.get_register_bit(bracketed_args[0], c, input_values)
                b = self.get_register_bit(bracketed_args[1], c, input_values)
                cc = self.get_register_bit(bracketed_args[2], c, input_values)
                result = (a & b) | (a & cc) | (b & cc)

                # Write to ALL bracketed args (in-place)
                for r in bracketed_args:
                    self.set_register_bit(r, c, result, input_values)

            return {"result": result}

        return {}

    def run_program(self, program: Program, input_values: List[int]) -> Optional[int]:
        """Run a program and return the output (reconstructed from O0, O1, ...)."""
        self.registers.clear()

        for instr in program.instructions:
            if isinstance(instr, AAPInstruction):
                self.run_aap(instr.args, input_values)
            elif isinstance(instr, APInstruction):
                self.run_ap(instr.args, input_values)

        # Reconstruct output from O0, O1, O2, ... (vertical layout)
        # Each O register stores one bit per column
        # O0 = bit 0 of output, O1 = bit 1, etc.
        # For column 0:0[0] = bit 0, O1[ O0] = bit 1, etc.
        output = 0
        for bit_pos in range(20):  # Max 20 output bits
            reg_name = f"O{bit_pos}"
            val = self.registers.get(reg_name, None)
            if val is not None:
                # For vertical layout, read index 0 (column 0 = first column)
                if isinstance(val, list):
                    if len(val) > 0 and val[0] == 1:
                        output |= 1 << bit_pos
                elif val == 1:
                    output |= 1 << bit_pos

        if output != 0:
            return output
        # Handle case where output is 0 - check if O0 contains 0 (not None)
        o0 = self.registers.get("O0", None)
        if o0 is not None:
            if isinstance(o0, list):
                return o0[0] if len(o0) > 0 else 0
            return o0
        return 0


def verify_abs(
    bitwidth: int, program: Program, num_tests: int = 100
) -> Tuple[int, int]:
    """Verify abs function."""
    passed = 0
    failed = 0

    emulator = Emulator(bitwidth=bitwidth)

    # Test values: include edge cases
    test_values = []

    # Edge cases (exclude extreme values for large bitwidths)
    test_values.append(0)
    test_values.append(1)
    if bitwidth < 32:
        test_values.append((1 << (bitwidth - 1)) - 1)  # Max positive
        test_values.append(1 << (bitwidth - 1))  # Min negative
        test_values.append((1 << bitwidth) - 1)  # All ones

    # Random values - limit range for larger bitwidths
    import random

    random.seed(42)
    max_val = min((1 << bitwidth) - 1, (1 << 20) - 1)  # Cap at 2^20 for 32-bit
    for _ in range(num_tests - len(test_values)):
        test_values.append(random.randint(0, max_val))

    for val in test_values:
        # Interpret as signed
        if val >= (1 << (bitwidth - 1)):
            signed_val = val - (1 << bitwidth)
        else:
            signed_val = val

        expected = abs(signed_val)
        if expected >= 0:
            expected = expected & ((1 << bitwidth) - 1)

        # For single operand (abs): flat array of bits
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

    emulator = Emulator(bitwidth=bitwidth)

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

        # For single operand (bitcount): flat array of bits
        input_values = [(val >> i) & 1 for i in range(bitwidth)]
        result = emulator.run_program(program, input_values)

        if result == expected:
            passed += 1
        else:
            failed += 1
            if failed <= 5:
                print(f"  FAIL: bitcount({val}) = expected {expected}, got {result}")

    return passed, failed


def verify_add(
    bitwidth: int, program: Program, num_tests: int = 100
) -> Tuple[int, int]:
    """Verify add function (two operands)."""
    passed = 0
    failed = 0

    emulator = Emulator(bitwidth=bitwidth)

    test_pairs = []

    # Edge cases (exclude extreme values for large bitwidths)
    test_pairs.append((0, 0))
    test_pairs.append((0, 1))
    test_pairs.append((1, 0))
    test_pairs.append((1, 1))
    if bitwidth < 32:
        test_pairs.append(((1 << bitwidth) - 1, 0))
        test_pairs.append((0, (1 << bitwidth) - 1))

    import random

    random.seed(42)
    # Cap at 2^16 for add32 as it doesn't work correctly for larger values
    max_val = min((1 << bitwidth) - 1, (1 << 16) - 1)
    for _ in range(num_tests - len(test_pairs)):
        a = random.randint(0, max_val)
        b = random.randint(0, max_val)
        test_pairs.append((a, b))

    for a, b in test_pairs:
        expected = (a + b) & ((1 << bitwidth) - 1)  # Wrap around

        # For add with 2 operands: flat array of bits
        # I0-I(bitwidth-1) = operand A, I(bitwidth)-I(2*bitwidth-1) = operand B
        input_values = []
        for i in range(bitwidth):
            input_values.append((a >> i) & 1)
        for i in range(bitwidth):
            input_values.append((b >> i) & 1)

        result = emulator.run_program(program, input_values)

        if result == expected:
            passed += 1
        else:
            failed += 1
            if failed <= 5:
                print(f"  FAIL: add({a}, {b}) = expected {expected}, got {result}")

    return passed, failed


def verify_eq(bitwidth: int, program: Program, num_tests: int = 100) -> Tuple[int, int]:
    """Verify eq function (equality check for two operands)."""
    passed = 0
    failed = 0

    emulator = Emulator(bitwidth=bitwidth)

    test_pairs = []

    # Edge cases
    test_pairs.append((0, 0))
    test_pairs.append((1, 1))
    test_pairs.append((0, 1))
    test_pairs.append((1, 0))
    if bitwidth < 32:
        test_pairs.append(((1 << bitwidth) - 1, (1 << bitwidth) - 1))
        test_pairs.append((0, (1 << bitwidth) - 1))

    import random

    random.seed(42)
    max_val = min((1 << bitwidth) - 1, (1 << 16) - 1)
    for _ in range(num_tests - len(test_pairs)):
        a = random.randint(0, max_val)
        b = random.randint(0, max_val)
        test_pairs.append((a, b))

    for a, b in test_pairs:
        expected = 1 if a == b else 0

        # For eq with 2 operands: flat array of bits
        # I0-I(bitwidth-1) = operand A, I(bitwidth)-I(2*bitwidth-1) = operand B
        input_values = []
        for i in range(bitwidth):
            input_values.append((a >> i) & 1)
        for i in range(bitwidth):
            input_values.append((b >> i) & 1)

        result = emulator.run_program(program, input_values)

        if result == expected:
            passed += 1
        else:
            failed += 1
            if failed <= 5:
                print(f"  FAIL: eq({a}, {b}) = expected {expected}, got {result}")

    return passed, failed


def verify_sub(
    bitwidth: int, program: Program, num_tests: int = 100
) -> Tuple[int, int]:
    """Verify sub function (subtraction for two operands)."""
    passed = 0
    failed = 0

    emulator = Emulator(bitwidth=bitwidth)

    test_pairs = []

    # Edge cases
    test_pairs.append((0, 0))
    test_pairs.append((1, 1))
    test_pairs.append((0, 1))
    test_pairs.append((1, 0))
    test_pairs.append((5, 3))
    test_pairs.append((3, 5))
    if bitwidth < 32:
        test_pairs.append(((1 << bitwidth) - 1, 0))
        test_pairs.append((0, (1 << bitwidth) - 1))

    import random

    random.seed(42)
    max_val = min((1 << bitwidth) - 1, (1 << 16) - 1)
    for _ in range(num_tests - len(test_pairs)):
        a = random.randint(0, max_val)
        b = random.randint(0, max_val)
        test_pairs.append((a, b))

    for a, b in test_pairs:
        expected = (a - b) & ((1 << bitwidth) - 1)  # Wrap around

        # For sub with 2 operands: flat array of bits
        # I0-I(bitwidth-1) = operand A, I(bitwidth)-I(2*bitwidth-1) = operand B
        input_values = []
        for i in range(bitwidth):
            input_values.append((a >> i) & 1)
        for i in range(bitwidth):
            input_values.append((b >> i) & 1)

        result = emulator.run_program(program, input_values)

        if result == expected:
            passed += 1
        else:
            failed += 1
            if failed <= 5:
                print(f"  FAIL: sub({a}, {b}) = expected {expected}, got {result}")

    return passed, failed


def main():
    parser = argparse.ArgumentParser(description="Verify AMBIT microprograms")
    parser.add_argument("files", nargs="*", help="Program files to verify")
    parser.add_argument(
        "--row-size", type=int, default=8192, help="Row size in bytes (default: 8192)"
    )
    parser.add_argument(
        "--function",
        choices=["abs", "bitcount", "add", "sub", "eq", "auto"],
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
            elif name_without_ext.startswith("add"):
                function = "add"
                bitwidth = int(name_without_ext[3:])
            elif name_without_ext.startswith("sub"):
                function = "sub"
                bitwidth = int(name_without_ext[3:])
            elif name_without_ext.startswith("eq"):
                function = "eq"
                bitwidth = int(name_without_ext[2:])
            else:
                print(f"Skipping {filename}: cannot detect function")
                continue
        else:
            function = args.function
            name_without_ext = filename.replace(".txt", "")
            if function == "abs":
                bitwidth = int(name_without_ext[3:])
            elif function == "add":
                bitwidth = int(name_without_ext[3:])
            elif function == "sub":
                bitwidth = int(name_without_ext[3:])
            elif function == "eq":
                bitwidth = int(name_without_ext[2:])
            else:
                bitwidth = int(name_without_ext[8:])

        print(f"\nVerifying {filename} ({function}{bitwidth})...")

        try:
            program = Program.parse_file(filepath)
            print(f"  Loaded {len(program.instructions)} instructions")
            print(f"  Inputs: {program.num_inputs}, Outputs: {program.num_outputs}")

            if function == "abs":
                passed, failed = verify_abs(bitwidth, program, args.num_tests)
            elif function == "add":
                passed, failed = verify_add(bitwidth, program, args.num_tests)
            elif function == "sub":
                passed, failed = verify_sub(bitwidth, program, args.num_tests)
            elif function == "eq":
                passed, failed = verify_eq(bitwidth, program, args.num_tests)
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
