/**
* @mixin
*/
declare class Observable {
    on(event: string, callback: any): this;
    one(event: string, callback: any): this;
    off(event: string, callback?: any): this;
    trigger(event: string, ...args: any[]): this;
};


declare let store: any;
declare let riot: any;
declare const ACTION: any;
declare const CHANGE: any;

declare let __dirname: string;
declare let process: any;

declare module "electron" {
    export let remote: any;    
    export let app: any;
    export let BrowserWindow: any;
}
