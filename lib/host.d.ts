import type { Context } from '@deepseek-ai/cordis';
import type z from '@deepseek-ai/schemastery';

export declare const name: string;
export declare const inject: string[];
export declare const Config: z<any>;
export declare function apply(ctx: Context, config: unknown): void;
