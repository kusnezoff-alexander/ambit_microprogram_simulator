// Ambit PIM Backend
// Implements AAP (Activate-Activate-Precharge) and AP (Activate-Precharge) instructions
// Based on AMBIT: In-Memory Accelerator for Bulk Bitwise Operations Using Commodity DRAM

const AmbitBackend = {
    name: 'Ambit',
    description: 'DRAM-based PIM using triple-row activation (AAP/AP)',

    // Instruction types recognized by this backend
    instructionTypes: ['AAP', 'AP'],

    // Default timing parameters (nanoseconds)
    timingDefaults: {
        AAP: 49,
        AP: 35
    },

    // Programs available for this backend
    programNames: [
        'abs4','abs8','abs16','abs32',
        'bitcount4','bitcount8','bitcount16','bitcount32',
        'add4','add8','add16','add32',
        'sub4','sub8','sub16','sub32',
        'mul4','mul8','mul16','mul32',
        'min4','min8','min16','min32',
        'max4','max8','max16','max32',
        'gt4','gt8','gt16','gt32',
        'ge4','ge8','ge16','ge32',
        'eq4','eq8','eq16','eq32',
        'ifelse4','ifelse8','ifelse16','ifelse32','ifelse64',
        'fa'
    ],

    // Program directory
    programDir: 'programs',

    // Memory array label
    memoryLabel: 'DRAM Array (Vertical Layout)',

    // Parse a program text into instruction objects
    parseProgram(text) {
        const lines = text.trim().split(/\r?\n/);
        const instrs = [];
        const inputs = new Set();
        const outputs = new Set();

        for (let line of lines) {
            if (!line.trim()) continue;
            line = line.replace(/\r$/, '');
            const m = line.match(/^(AAP|AP)\s+(.*)$/);
            if (m) {
                const args = this._parseArgs(m[2]);
                instrs.push({ type: m[1], args: args });
                this._trackIO(args, inputs, outputs);
            }
        }
        return { instrs, inputs: inputs.size, outputs: outputs.size };
    },

    // Execute a single instruction, mutating registers in-place
    stepInstruction(instr, registers, numCols, getReg, setReg) {

        if (instr.type === 'AAP') {
            this._execAAP(instr, numCols, getReg, setReg);
        } else if (instr.type === 'AP') {
            this._execAP(instr, numCols, getReg, setReg);
        }
    },

    // Compute instruction counts for statistics
    getStats(program) {
        const counts = { AAP: 0, AP: 0 };
        for (const instr of program.instrs) {
            if (instr.type === 'AAP') counts.AAP++;
            else if (instr.type === 'AP') counts.AP++;
        }
        return counts;
    },

    // Format statistics HTML
    formatStats(counts, timings) {
        const tAAP = timings.AAP || 0;
        const tAP = timings.AP || 0;
        const totalLatency = counts.AAP * tAAP + counts.AP * tAP;

        let html = `<b>${counts.AAP}</b> AAP &times; ${tAAP} ns = ${(counts.AAP * tAAP).toFixed(1)} ns<br>`;
        html += `<b>${counts.AP}</b> AP &times; ${tAP} ns = ${(counts.AP * tAP).toFixed(1)} ns<br>`;
        html += `<b>Total: ${counts.AAP + counts.AP}</b> instructions, <b>${totalLatency.toFixed(1)} ns</b> latency`;
        return html;
    },

    // --- Private helpers ---

    _parseArgs(argStr) {
        const args = [];
        let current = '';
        let inBracket = false;
        for (let i = 0; i < argStr.length; i++) {
            const ch = argStr[i];
            if (ch === '[') { inBracket = true; current += ch; }
            else if (ch === ']') { inBracket = false; current += ch; }
            else if (ch === ' ' && !inBracket) {
                if (current) { args.push(current); current = ''; }
            } else { current += ch; }
        }
        if (current) args.push(current);
        return args;
    },

    _trackIO(args, inputs, outputs) {
        for (const a of args) {
            const clean = a.replace(/[\[\]]/g, '');
            const parts = clean.split(',');
            for (const part of parts) {
                const c = part.trim().replace(/^~/, '');
                if (c.startsWith('I')) {
                    const num = parseInt(c.slice(1));
                    if (!isNaN(num)) inputs.add(num);
                }
                if (c.startsWith('O')) {
                    const num = parseInt(c.slice(1));
                    if (!isNaN(num)) outputs.add(num);
                }
            }
        }
    },

    _execAAP(instr, numCols, getReg, setReg) {
        // AAP semantics:
        // AAP src dest          -> copy src to dest
        // AAP [T0,T1,T2] dest   -> MAJ3(T0,T1,T2) written to all bracket args AND dest
        // AAP src [T0,T1]       -> copy src to all of T0,T1 (multi-row copy)
        let bracketedArgs = [];
        let nonBracketedArgs = [];

        for (let i = 0; i < instr.args.length; i++) {
            const arg = instr.args[i];
            if (arg.startsWith('[') && arg.endsWith(']')) {
                bracketedArgs = arg.slice(1, -1).split(',').map(s => s.trim());
            } else {
                nonBracketedArgs.push({ arg, idx: i });
            }
        }

        for (let c = 0; c < numCols; c++) {
            if (bracketedArgs.length >= 3 && nonBracketedArgs.length >= 1) {
                // MAJ3 with destination
                const a = getReg(bracketedArgs[0], c);
                const b = getReg(bracketedArgs[1], c);
                const cc = getReg(bracketedArgs[2], c);
                const result = (a & b) | (a & cc) | (b & cc);
                for (const r of bracketedArgs) { setReg(r, c, result); }
                const dest = nonBracketedArgs[nonBracketedArgs.length - 1].arg;
                setReg(dest, c, result);
            } else if (bracketedArgs.length > 0 && bracketedArgs.length < 3 && nonBracketedArgs.length >= 1) {
                // Multi-row copy
                const src = nonBracketedArgs[0].arg;
                const val = getReg(src, c);
                for (const dest of bracketedArgs) { setReg(dest, c, val); }
            } else if (bracketedArgs.length === 0 && nonBracketedArgs.length === 2) {
                // Simple copy
                const src = nonBracketedArgs[0].arg;
                const dest = nonBracketedArgs[1].arg;
                setReg(dest, c, getReg(src, c));
            }
        }
    },

    _execAP(instr, numCols, getReg, setReg) {
        // AP [T0, T1, T2]: MAJ3 in-place on all bracketed args
        let bracketedArgs = [];
        for (const arg of instr.args) {
            if (arg.startsWith('[') && arg.endsWith(']')) {
                bracketedArgs = arg.slice(1, -1).split(',').map(s => s.trim());
            }
        }

        if (bracketedArgs.length >= 3) {
            for (let c = 0; c < numCols; c++) {
                const a = getReg(bracketedArgs[0], c);
                const b = getReg(bracketedArgs[1], c);
                const cc = getReg(bracketedArgs[2], c);
                const result = (a & b) | (a & cc) | (b & cc);
                for (const dest of bracketedArgs) { setReg(dest, c, result); }
            }
        }
    }
};
