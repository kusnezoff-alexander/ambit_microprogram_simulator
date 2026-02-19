#!/usr/bin/env python3
"""
Enhanced structural verification for AMBIT microprograms.
Checks program structure, patterns, and consistency.
"""

import re
import os
import math
from typing import Dict, List, Tuple, Set


class ProgramAnalyzer:
    def __init__(self, filepath: str):
        self.filepath = filepath
        self.aap_count = 0
        self.ap_count = 0
        self.inputs: Set[int] = set()
        self.outputs: Set[int] = set()
        self.registers_used: Set[str] = set()
        self.constants_used: Set[str] = set()
        self.instruction_lines: List[Tuple[str, List[str]]] = []
        self._parse()

    def _parse(self):
        """Parse the program file."""
        with open(self.filepath, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue

                if line.startswith("AAP "):
                    self.aap_count += 1
                    args = self._parse_args(line[4:])
                    self.instruction_lines.append(("AAP", args))
                    self._analyze_args(args)
                elif line.startswith("AP "):
                    self.ap_count += 1
                    args = self._parse_args(line[3:])
                    self.instruction_lines.append(("AP", args))
                    self._analyze_args(args)

    def _parse_args(self, arg_str: str) -> List[str]:
        """Parse arguments, handling brackets properly."""
        args = []
        current = ""
        in_bracket = False
        for ch in arg_str:
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
        return args

    def _analyze_args(self, args: List[str]):
        """Analyze what registers/inputs/outputs are used."""
        for arg in args:
            # Handle negation
            clean = arg
            if arg.startswith("~"):
                clean = arg[1:]

            # Remove brackets
            if clean.startswith("[") and clean.endswith("]"):
                inner = clean[1:-1]
                for part in inner.split(","):
                    part = part.strip()
                    self._analyze_single_arg(part)
            else:
                self._analyze_single_arg(clean)

    def _analyze_single_arg(self, arg: str):
        """Analyze a single argument."""
        if arg.startswith("I"):
            try:
                self.inputs.add(int(arg[1:]))
            except:
                pass
        elif arg.startswith("O"):
            try:
                self.outputs.add(int(arg[1:]))
            except:
                pass
        elif arg.startswith("T"):
            try:
                self.registers_used.add(arg)
            except:
                pass
        elif arg.startswith("S"):
            try:
                self.registers_used.add(arg)
            except:
                pass
        elif arg.startswith("DCC"):
            try:
                self.registers_used.add(arg)
            except:
                pass
        elif arg == "C0":
            self.constants_used.add("C0")
        elif arg == "C1":
            self.constants_used.add("C1")

    @property
    def total_instructions(self) -> int:
        return self.aap_count + self.ap_count

    @property
    def max_input(self) -> int:
        return max(self.inputs) + 1 if self.inputs else 0

    @property
    def max_output(self) -> int:
        return max(self.outputs) + 1 if self.outputs else 0

    def check_structure(self, function: str, bitwidth: int) -> List[str]:
        """Check if program has correct structure."""
        errors = []

        # Check input count
        expected_inputs = bitwidth
        if self.max_input != expected_inputs:
            errors.append(f"Expected {expected_inputs} inputs, found {self.max_input}")

        # Check output count
        if function == "abs":
            expected_outputs = bitwidth
        elif function == "bitcount":
            expected_outputs = (bitwidth + 1).bit_length()

        if self.max_output != expected_outputs:
            errors.append(
                f"Expected {expected_outputs} outputs for {function}{bitwidth}, found {self.max_output}"
            )

        # Check that program has both AAP and AP instructions (for non-trivial functions)
        if function in ["abs", "bitcount"] and bitwidth >= 4:
            if self.aap_count < 10:
                errors.append(
                    f"Program seems too small: only {self.aap_count} AAP instructions"
                )

        # Check for constant usage (should use C0 and C1)
        if not self.constants_used:
            errors.append("No constants (C0/C1) used")

        return errors

    def get_statistics(self) -> Dict:
        """Get detailed program statistics."""
        # Count different types of operations
        ops_with_negation = 0
        ops_with_brackets = 0
        dest_registers = set()

        for instr_type, args in self.instruction_lines:
            # Check for negation
            for arg in args:
                if arg.startswith("~"):
                    ops_with_negation += 1
                if "[" in arg:
                    ops_with_brackets += 1

            # Last arg is typically destination
            if args:
                dest = args[-1]
                if not dest.startswith("["):
                    dest_registers.add(dest)

        return {
            "aap_count": self.aap_count,
            "ap_count": self.ap_count,
            "total": self.total_instructions,
            "max_input": self.max_input,
            "max_output": self.max_output,
            "unique_registers": len(self.registers_used),
            "ops_with_negation": ops_with_negation,
            "ops_with_brackets": ops_with_brackets,
            "dest_registers": len(dest_registers),
        }


def verify_programs(filepaths: List[str], function: str = "auto") -> None:
    """Verify multiple program files."""
    results = []

    for filepath in filepaths:
        filename = os.path.basename(filepath)
        name = filename.replace(".txt", "")

        # Detect function and bitwidth
        if name.startswith("abs"):
            func = "abs"
            try:
                bitwidth = int(name[3:])
            except:
                continue
        elif name.startswith("bitcount"):
            func = "bitcount"
            try:
                bitwidth = int(name[8:])
            except:
                continue
        else:
            if function == "auto":
                continue
            continue

        try:
            analyzer = ProgramAnalyzer(filepath)
            errors = analyzer.check_structure(func, bitwidth)
            stats = analyzer.get_statistics()

            results.append(
                {
                    "file": filename,
                    "func": func,
                    "bitwidth": bitwidth,
                    "errors": errors,
                    "stats": stats,
                    "ok": len(errors) == 0,
                }
            )
        except Exception as e:
            results.append(
                {
                    "file": filename,
                    "func": func,
                    "bitwidth": bitwidth,
                    "errors": [str(e)],
                    "stats": {},
                    "ok": False,
                }
            )

    # Print results
    print("=" * 80)
    print(
        f"{'Program':<20} {'Function':<12} {'AAP':<6} {'AP':<6} {'Total':<6} {'Inputs':<8} {'Outputs':<8} {'Status':<10}"
    )
    print("=" * 80)

    for r in results:
        stats = r["stats"]
        status = "✓ OK" if r["ok"] else "✗ FAIL"

        print(
            f"{r['file']:<20} {r['func']}{r['bitwidth']:<8} "
            f"{stats.get('aap_count', 0):<6} {stats.get('ap_count', 0):<6} "
            f"{stats.get('total', 0):<6} {stats.get('max_input', 0):<8} "
            f"{stats.get('max_output', 0):<8} {status:<10}"
        )

    print("=" * 80)

    # Print errors
    errors_found = sum(1 for r in results if not r["ok"])
    if errors_found > 0:
        print(f"\nErrors found in {errors_found} programs:")
        for r in results:
            if not r["ok"]:
                print(f"\n  {r['file']}:")
                for e in r["errors"]:
                    print(f"    - {e}")
    else:
        print(f"\n✓ All {len(results)} programs verified successfully!")


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Verify AMBIT microprogram structure")
    parser.add_argument("files", nargs="*", help="Program files to verify")
    parser.add_argument(
        "--function", choices=["abs", "bitcount", "auto"], default="auto"
    )
    args = parser.parse_args()

    if not args.files:
        # Find files in current directory
        for f in os.listdir("."):
            if f.endswith(".txt") and (f.startswith("abs") or f.startswith("bitcount")):
                args.files.append(f)

    verify_programs(args.files, args.function)


if __name__ == "__main__":
    main()
