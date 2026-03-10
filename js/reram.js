// ReRAM / MAGIC NOR Backend  (SIMPLER-MAGIC JSON programs)
// ==========================================================
//
// Based on: MAGIC — Memristor-Aided LoGIC  (Kvatinsky et al., 2014)
//           SIMPLER MAGIC — Synthesis & Mapping  (Ben-Hur et al., 2020)
//
// Programs are JSON files produced by SIMPLER-MAGIC.  Each file describes a
// cycle-by-cycle execution plan for computing a combinational function inside
// a single crossbar *row* of memristors.
//
// Execution model
// ---------------
//   - A row has `rowSize` cells numbered 0 .. rowSize-1.
//   - Input signals occupy fixed cells declared in the JSON metadata.
//   - Each clock cycle executes exactly one of:
//       inv1  (NOT):  dest = ~src                       (1 gate, 1 cycle)
//       nor2  (NOR):  dest = ~(srcA | srcB)             (1 gate, 1 cycle)
//       Initialization(Ron): batch-reset cells to 0     (1 cycle)
//   - Output signals land in cells declared in the metadata.
//
// Parallelism across rows
// -----------------------
// Every row in the physical crossbar executes the *same* program in lock-step.
// Each row is an independent data lane (like SIMD).  In the visualiser we show
// N rows, one per parallel computation element.

const ReRAMBackend = {
    name: 'ReRAM',
    description: 'Memristive crossbar PIM using MAGIC NOR gates (SIMPLER-MAGIC)',

    instructionTypes: ['nor2', 'inv1', 'init'],

    timingDefaults: {
        nor2: 1,
        inv1: 1,
        init: 1
    },

    // Populated dynamically — one entry per JSON file in programs_reram/
    programNames: [
        'JSON_32_abs_8bit',
        'JSON_32_adder_8bit',
        'JSON_32_subtractor_8bit',
        'JSON_32_multiplier_4bit',
        'JSON_32_popcount_8bit',
        'JSON_64_abs_8bit',
        'JSON_64_adder_8bit',
        'JSON_64_subtractor_8bit',
        'JSON_64_multiplier_4bit',
        'JSON_64_popcount_8bit',
        'JSON_128_abs_8bit',
        'JSON_128_adder_8bit',
        'JSON_128_subtractor_8bit',
        'JSON_128_multiplier_4bit',
        'JSON_128_popcount_8bit',
        'JSON_256_abs_8bit',
        'JSON_256_adder_8bit',
        'JSON_256_subtractor_8bit',
        'JSON_256_multiplier_4bit',
        'JSON_256_popcount_8bit'
    ],

    programDir: 'programs_reram',
    programExt: '.json',           // override default .txt

    memoryLabel: 'Crossbar Row (Horizontal Layout)',

    highlightColumns: true,

    // ------------------------------------------------------------------
    // Parse a SIMPLER-MAGIC JSON file (already parsed to object by core)
    // ------------------------------------------------------------------
    parseProgram(text) {
        const json = JSON.parse(text);

        const rowSize    = json['Row size'];
        const benchmark  = json['Benchmark'] || '';
        const numInputs  = json['Number of Inputs'];
        const numOutputs = json['Number of outputs'];
        const totalCycles = json['Total cycles'];
        const reuseCycles = json['Reuse cycles'];

        // Parse input map: "{A0(0),A1(1),...}" -> [{name,cell}, ...]
        const inputMap  = this._parseSignalMap(json['Inputs']);
        const outputMap = this._parseSignalMap(json['Outputs']);

        // Parse execution sequence
        const execSeq = json['Execution sequence'];
        const instrs = [];
        // Keys are T0, T1, T2, ... — iterate in numeric order
        const keys = Object.keys(execSeq).sort((a, b) => {
            return parseInt(a.slice(1)) - parseInt(b.slice(1));
        });

        for (const key of keys) {
            const raw = execSeq[key];
            const parsed = this._parseInstruction(raw);
            // Store the display string alongside the parsed instruction
            parsed.display = raw;
            parsed.cycle = key;
            instrs.push(parsed);
        }

        // Derive bitwidth: for unary ops it's numInputs, for binary it's half
        // We can't know for sure, so store the raw counts and let the
        // metadata-aware code figure it out.
        return {
            instrs,
            inputs: numInputs,
            outputs: numOutputs,
            // Extra metadata specific to ReRAM / SIMPLER-MAGIC
            rowSize,
            benchmark,
            inputMap,
            outputMap,
            totalCycles,
            reuseCycles
        };
    },

    // ------------------------------------------------------------------
    // Instruction execution
    // ------------------------------------------------------------------
    stepInstruction(instr, registers, bitWidth, getReg, setReg) {
        // registers is { R0: [...cells...], R1: [...], ... }
        // Each row is an independent lane; apply the same op to every row.
        const rowNames = Object.keys(registers);

        if (instr.type === 'nor2') {
            const { srcA, srcB, dest } = instr;
            for (const rn of rowNames) {
                const row = registers[rn];
                const a = row[srcA] ?? 0;
                const b = row[srcB] ?? 0;
                row[dest] = (a | b) ? 0 : 1;
            }
        } else if (instr.type === 'inv1') {
            const { src, dest } = instr;
            for (const rn of rowNames) {
                const row = registers[rn];
                row[dest] = (row[src] ?? 0) ? 0 : 1;
            }
        } else if (instr.type === 'init') {
            const { cells } = instr;
            for (const rn of rowNames) {
                const row = registers[rn];
                for (const c of cells) {
                    row[c] = 0;
                }
            }
        }
    },

    // ------------------------------------------------------------------
    // Activated-cell highlighting  (column indices)
    // ------------------------------------------------------------------
    getActivatedCells(instr) {
        const set = new Set();
        if (!instr) return set;
        if (instr.type === 'nor2') {
            set.add('col:' + instr.srcA);
            set.add('col:' + instr.srcB);
            set.add('col:' + instr.dest);
        } else if (instr.type === 'inv1') {
            set.add('col:' + instr.src);
            set.add('col:' + instr.dest);
        } else if (instr.type === 'init') {
            for (const c of instr.cells) set.add('col:' + c);
        }
        return set;
    },

    // ------------------------------------------------------------------
    // Register initialisation  (called from core.js loadProgram)
    // ------------------------------------------------------------------
    initRegisters(program, inputArray, isBinaryOp, bitWidth, registers) {
        const rowSize = program.rowSize;
        const inputMap = program.inputMap;   // [{name,cell}, ...]

        // Determine number of parallel lanes (rows).
        // For binary ops: inputArray is transposed by core into [[opA,opB], [opA,opB], ...]
        //   so inputArray.length = number of lanes.
        // For unary ops: inputArray is [val0, val1, val2, ...] — one lane per value.
        const numLanes = isBinaryOp
            ? inputArray.length
            : inputArray.length;

        for (let lane = 0; lane < numLanes; lane++) {
            const rowName = 'R' + lane;
            registers[rowName] = new Array(rowSize).fill(null);

            // Place input bits at their declared cell positions
            if (isBinaryOp) {
                // inputArray[lane] = [opA_val, opB_val, ...] (transposed by core)
                const vals = Array.isArray(inputArray[lane]) ? inputArray[lane] : [inputArray[lane]];
                // inputMap has e.g. A0(0)..A7(7), B0(8)..B7(15), maybe Cin(16)
                // Group inputs by operand prefix
                let bitIdx = 0;
                let currentPrefix = null;
                let opIdx = 0;

                for (const inp of inputMap) {
                    // Detect operand boundary: prefix changes (A->B, B->C, etc.)
                    const prefix = inp.name.replace(/\d+$/, '');
                    if (currentPrefix !== null && prefix !== currentPrefix) {
                        opIdx++;
                        bitIdx = 0;
                    }
                    currentPrefix = prefix;

                    const value = vals[opIdx] || 0;
                    registers[rowName][inp.cell] = (value >> bitIdx) & 1;
                    bitIdx++;
                }
            } else {
                // Unary: lane-th value spread across input cells
                const value = Array.isArray(inputArray[lane])
                    ? inputArray[lane][0]
                    : (inputArray[lane] || 0);
                for (let i = 0; i < inputMap.length; i++) {
                    registers[rowName][inputMap[i].cell] = (value >> i) & 1;
                }
            }
        }
    },

    // ------------------------------------------------------------------
    // Output reconstruction
    // ------------------------------------------------------------------
    reconstructOutput(registers, _outputRowNames, _numCols, _bitWidth) {
        // Read output bits from the cells declared in program.outputMap.
        // Only include numbered result signals (S0-S7, D0-D7, R0-R7, P0-P7, C0-C3).
        // Skip flag signals like Cout, Bout that are not part of the numeric result.
        const prog = program;  // global from core.js
        if (!prog || !prog.outputMap) return [];
        const outputMap = prog.outputMap;
        const rowNames = Object.keys(registers).filter(r => r.startsWith('R'))
            .sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));

        // Filter to only numbered output signals and extract bit position from name
        const resultBits = [];
        for (const sig of outputMap) {
            const m = sig.name.match(/^[A-Za-z]+(\d+)$/);
            if (m) {
                resultBits.push({ cell: sig.cell, bitPos: parseInt(m[1]) });
            }
            // else: skip flags like Cout, Bout
        }

        const vals = [];
        for (const rn of rowNames) {
            const row = registers[rn];
            let outVal = 0;
            let allNull = true;
            for (const { cell, bitPos } of resultBits) {
                if (row[cell] !== null && row[cell] !== undefined) {
                    allNull = false;
                    if (row[cell] === 1) outVal |= (1 << bitPos);
                }
            }
            vals.push(allNull ? null : outVal);
        }
        return vals;
    },

    // ------------------------------------------------------------------
    // Statistics
    // ------------------------------------------------------------------
    getStats(program) {
        const counts = { nor2: 0, inv1: 0, init: 0 };
        for (const instr of program.instrs) {
            if (counts.hasOwnProperty(instr.type)) counts[instr.type]++;
        }
        return counts;
    },

    formatStats(counts, timings) {
        const tNOR  = timings.nor2 || 0;
        const tINV  = timings.inv1 || 0;
        const tINIT = timings.init || 0;
        const gates = counts.nor2 + counts.inv1;
        const total = gates + counts.init;
        const latency = counts.nor2 * tNOR + counts.inv1 * tINV + counts.init * tINIT;

        let html = '';
        html += `<b>${counts.nor2}</b> NOR2 &times; ${tNOR} ns = ${(counts.nor2 * tNOR).toFixed(1)} ns<br>`;
        html += `<b>${counts.inv1}</b> INV1 &times; ${tINV} ns = ${(counts.inv1 * tINV).toFixed(1)} ns<br>`;
        html += `<b>${counts.init}</b> INIT &times; ${tINIT} ns = ${(counts.init * tINIT).toFixed(1)} ns<br>`;
        html += `<b>Total: ${gates}</b> gates + ${counts.init} init = <b>${total}</b> cycles, `;
        html += `<b>${latency.toFixed(1)} ns</b> latency`;
        return html;
    },

    // ------------------------------------------------------------------
    // Custom renderer — shows one row as a horizontal array of cells
    // ------------------------------------------------------------------
    render(prog, registers, bitWidth, currentPc, activated, previous, scrollOff) {
        const rowSize = prog.rowSize;
        const inputMap  = prog.inputMap;
        const outputMap = prog.outputMap;

        // Build sets of input/output cell indices for coloring
        const inputCells  = new Set(inputMap.map(s => s.cell));
        const outputCells = new Set(outputMap.map(s => s.cell));

        // Build name lookup: cell -> signal name
        const cellNames = {};
        for (const s of inputMap)  cellNames[s.cell] = s.name;
        for (const s of outputMap) cellNames[s.cell] = s.name;

        const rowNames = Object.keys(registers).filter(r => r.startsWith('R'))
            .sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));

        let html = '<div>';
        html += `<div style="font-size:12px; color:#666; margin-bottom:6px;">`;
        html += `${rowSize} cells/row &times; ${rowNames.length} lane(s)`;
        html += `</div>`;

        // Scrollable table wrapper
        html += '<div style="overflow-x:auto; max-width:100%; border:1px solid #dee2e6; border-radius:4px;">';
        html += '<table style="border-collapse:collapse; white-space:nowrap;">';

        // --- Signal-name header with rotated labels ---
        // Combines cell index + signal name in a single header row with rotated text
        html += '<tr>';
        html += '<th style="padding:2px 5px; background:#007bff; color:white; font-size:10px; position:sticky; left:0; z-index:2; min-width:30px; vertical-align:bottom;">Row</th>';
        for (let c = 0; c < rowSize; c++) {
            let thBg = '#adb5bd';
            if (inputCells.has(c)) thBg = '#28a745';
            else if (outputCells.has(c)) thBg = '#dc3545';
            const name = cellNames[c] || '';
            const label = name ? `${c} ${name}` : `${c}`;
            const title = name ? `${name} (cell ${c})` : `cell ${c}`;
            html += `<th style="padding:1px 1px; background:${thBg}; color:white; font-size:9px; min-width:20px; height:42px; vertical-align:bottom; text-align:center;" title="${title}">`;
            html += `<div style="writing-mode:vertical-lr; transform:rotate(180deg); font-family:monospace; font-size:9px; line-height:1; white-space:nowrap;">${label}</div>`;
            html += `</th>`;
        }
        html += '</tr>';

        // --- Data rows ---
        for (const rn of rowNames) {
            const row = registers[rn];
            html += '<tr>';
            html += `<td style="padding:2px 5px; background:#e7f3ff; font-weight:bold; font-family:monospace; font-size:10px; position:sticky; left:0; z-index:1;">${rn}</td>`;
            for (let c = 0; c < rowSize; c++) {
                const v = row[c];
                let bg = v === 1 ? '#d4edda' : v === 0 ? '#f8d7da' : '#f5f5f5';
                let color = v === 1 ? '#28a745' : v === 0 ? '#dc3545' : '#999';
                let extra = '';

                // Highlight activated / previous columns
                const colKey = 'col:' + c;
                if (activated.has(colKey)) {
                    bg = v === 1 ? '#c3e6cb' : v === 0 ? '#f5c6cb' : '#e9ecef';
                    extra = 'outline:2px solid #ffc107; outline-offset:-2px;';
                } else if (previous.has(colKey)) {
                    bg = v === 1 ? '#c8e6c9' : v === 0 ? '#f5c6cb' : '#e0e0e0';
                    extra = 'outline:2px solid #17a2b8; outline-offset:-2px;';
                }

                const display = v === null ? '?' : v;
                html += `<td data-row="${rn}" data-col="${c}" style="padding:2px 3px; background:${bg}; color:${color}; text-align:center; font-family:monospace; font-size:10px; ${extra}">${display}</td>`;
            }
            html += '</tr>';
        }

        html += '</table>';
        html += '</div>';  // end scrollable wrapper

        // Legend
        html += '<div style="margin-top:8px; font-size:11px; color:#666; display:flex; gap:14px; flex-wrap:wrap;">';
        html += '<span><span style="display:inline-block;width:12px;height:12px;background:#28a745;border:1px solid #ccc;vertical-align:middle;margin-right:4px;"></span>Input</span>';
        html += '<span><span style="display:inline-block;width:12px;height:12px;background:#dc3545;border:1px solid #ccc;vertical-align:middle;margin-right:4px;"></span>Output</span>';
        html += '<span><span style="display:inline-block;width:12px;height:12px;background:#adb5bd;border:1px solid #ccc;vertical-align:middle;margin-right:4px;"></span>Scratch</span>';
        html += '<span><span style="display:inline-block;width:12px;height:12px;background:#ffc107;border:1px solid #ccc;vertical-align:middle;margin-right:4px;"></span>Active</span>';
        html += '<span><span style="display:inline-block;width:12px;height:12px;background:#17a2b8;border:1px solid #ccc;vertical-align:middle;margin-right:4px;"></span>Previous</span>';
        html += '</div>';

        html += '</div>';
        html += '<div id="result" style="margin-top:12px; padding-top:12px; border-top:1px solid #dee2e6;"></div>';
        document.getElementById('memory').innerHTML = html;
    },

    // ------------------------------------------------------------------
    // Private helpers
    // ------------------------------------------------------------------

    // Parse "{A0(0),A1(1),B0(8),...}" -> [{name:'A0',cell:0}, ...]
    _parseSignalMap(str) {
        if (!str) return [];
        const inner = str.replace(/^\{/, '').replace(/\}$/, '');
        const signals = [];
        const parts = inner.split(',');
        for (const part of parts) {
            const m = part.trim().match(/^(\w+)\((\d+)\)$/);
            if (m) {
                signals.push({ name: m[1], cell: parseInt(m[2]) });
            }
        }
        return signals;
    },

    // Parse one execution-sequence entry into a structured instruction
    _parseInstruction(raw) {
        // Initialization(Ron){...}
        if (raw.startsWith('Initialization')) {
            const cells = [];
            const inner = raw.match(/\{(.+)\}/);
            if (inner) {
                // Entries like 'INIT_CYCLE(8)' or 'new_n17(28)'
                const parts = inner[1].split(',');
                for (const p of parts) {
                    const m = p.trim().replace(/^'|'$/g, '').match(/\((\d+)\)/);
                    if (m) cells.push(parseInt(m[1]));
                }
            }
            return { type: 'init', cells, args: cells.map(String) };
        }

        // inv1: "new_n18(31)=inv1{A0(0)}"
        const invMatch = raw.match(/^(\w+)\((\d+)\)=inv1\{(\w+)\((\d+)\)\}$/);
        if (invMatch) {
            return {
                type: 'inv1',
                destName: invMatch[1],
                dest: parseInt(invMatch[2]),
                srcName: invMatch[3],
                src: parseInt(invMatch[4]),
                args: [invMatch[4], invMatch[2]]    // [src, dest] for display
            };
        }

        // nor2: "new_n20(29)=nor2{new_n19(30),new_n18(31)}"
        const norMatch = raw.match(/^(\w+)\((\d+)\)=nor2\{(\w+)\((\d+)\),(\w+)\((\d+)\)\}$/);
        if (norMatch) {
            return {
                type: 'nor2',
                destName: norMatch[1],
                dest: parseInt(norMatch[2]),
                srcAName: norMatch[3],
                srcA: parseInt(norMatch[4]),
                srcBName: norMatch[5],
                srcB: parseInt(norMatch[6]),
                args: [norMatch[4], norMatch[6], norMatch[2]]  // [srcA, srcB, dest]
            };
        }

        // Fallback
        return { type: 'unknown', args: [], display: raw };
    }
};
