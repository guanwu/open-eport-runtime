import { CardApi } from "./card";
import { ExecApi } from "./exec";
import { FilesApi } from "./files";
import { HttpApi } from "./http";
export interface ConnectOptions {
    url?: string;
    timeoutMs?: number;
    wake?: boolean;
}
export declare class AgentClient {
    private readonly connection;
    readonly exec: ExecApi;
    readonly fs: FilesApi;
    readonly http: HttpApi;
    readonly card: CardApi;
    private constructor();
    static connect(options?: ConnectOptions): Promise<AgentClient>;
    cancel(): void;
    close(): void;
}
export declare function connect(options?: ConnectOptions): Promise<AgentClient>;
