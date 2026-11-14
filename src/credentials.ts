import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

type Stored = Record<string, Credential>;

/**
 * Credentials in one JSON file readable by the owner only.
 *
 * Writes are serialized within this process. Two brouillon processes refreshing
 * the same OAuth token at the same moment are not excluded from each other:
 * the loser's refresh fails and that session has to sign in again.
 */
export class FileCredentialStore implements CredentialStore {
  private readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return (await this.load())[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const stored = await this.load();
    return Object.entries(stored).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.serialize(async () => {
      const stored = await this.load();
      const next = await fn(stored[providerId]);
      if (next === undefined) return stored[providerId];
      stored[providerId] = next;
      await this.save(stored);
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.serialize(async () => {
      const stored = await this.load();
      if (!(providerId in stored)) return;
      delete stored[providerId];
      await this.save(stored);
    });
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<Stored> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    return JSON.parse(raw) as Stored;
  }

  private async save(stored: Stored): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    // writeFile's mode is ignored when the temporary file already exists.
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
}
