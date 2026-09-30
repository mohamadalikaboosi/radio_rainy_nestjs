declare module 's3rver' {
  interface S3rverOptions {
    port: number;
    address: string;
    silent?: boolean;
    directory: string;
    configureBuckets?: { name: string; configs: unknown[] }[];
  }
  export default class S3rver {
    constructor(options: S3rverOptions);
    run(): Promise<{ address: string; port: number } | string>;
    close(): Promise<void>;
  }
}
