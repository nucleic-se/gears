/** Fixed reconciliation workload with an independently checkable result. No private data. */
export function reconciliationFixture() {
    const files: Record<string, string> = {};
    const totals: number[] = [];
    for (const [index, name] of ['A', 'B'].entries()) {
        let total = 0;
        const rows = ['id,amount,status'];
        for (let row = 1; row <= 120; row++) {
            const amount = (row * 17 + index * 13) % 101;
            const included = row % 7 !== 0;
            if (included) total += amount;
            rows.push(`${name}-${row},${amount},${included ? 'posted' : 'void'}`);
        }
        files[`${name}.csv`] = rows.join('\n') + '\n';
        totals.push(total);
    }
    const expected = `A=${totals[0]} B=${totals[1]} TOTAL=${totals[0] + totals[1]}`;
    const prompt = `Reconcile A.csv and B.csv. Sum only posted amounts; ignore void rows.
First delegate exactly two children, one file per child, using spawn_agent with tools ["fs_read","save_artifact","save_progress"] and maxCalls 8. Each child must read its actual file and save its total to a distinct artifact. Wait for both using wait_agents, read their artifacts, and save_progress with both totals. Then call schedule_self ONCE with delaySeconds 30 and reason "Resume after restart acceptance check". Do not finish before waking. After waking, write review.md containing exactly A=<sum> B=<sum> TOTAL=<combined sum>, substituting integer values. Give that same result as your final answer. Do not modify input files.`;
    return { files, expected, prompt };
}
