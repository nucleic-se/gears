export interface MetricSnapshot {
    name: string;
    value: number;
    type: 'counter' | 'gauge';
    tags: Record<string, string>;
    updatedAt: number;
}

export interface IMetrics {
    /**
     * Increment a counter.
     */
    increment(name: string, value?: number, tags?: Record<string, string>): Promise<void>;

    /**
     * Set a gauge value.
     */
    gauge(name: string, value: number, tags?: Record<string, string>): Promise<void>;

    /**
     * Get a snapshot of all metrics.
     */
    snapshot(): Promise<MetricSnapshot[]>;
}
