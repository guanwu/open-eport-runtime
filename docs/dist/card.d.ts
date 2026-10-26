import type { InputSource, Invoke, ProgressHandler } from "./connection";
import type { EmptyResult } from "./files";
import type { CardDevice, CardSignature } from "./protocol";
export type { CardDevice, CardSignature };
export interface CardListResult {
    devices: CardDevice[];
}
export interface CardVerifyParams {
    device: string;
    deviceId: string;
    pin: string;
}
export type CardSignParams = CardVerifyParams;
export interface CardSignIo {
    input: InputSource;
    onProgress?: ProgressHandler;
}
export declare class CardApi {
    private readonly invoke;
    constructor(invoke: Invoke);
    list(): Promise<CardListResult>;
    verify(params: CardVerifyParams): Promise<EmptyResult>;
    sign(params: CardSignParams, io: CardSignIo): Promise<CardSignature>;
}
