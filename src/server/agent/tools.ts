import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolDefinition, ToolResult } from "../../shared/protocol";
import { text } from "./message";

export type RegisteredTool = ToolDefinition & {
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
};

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  definitions(): ToolDefinition[] {
    return Array.from(this.tools.values(), ({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return tool.execute(args);
  }
}

export function createToolRegistry(workspaceRoot: string): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register({
    name: "list_files",
    description: "List files and directories directly inside a workspace directory.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Workspace-relative directory path." } },
      additionalProperties: false,
    },
    execute: async (args) => {
      const input = optionalString(args, "path") ?? ".";
      const { root, target } = await resolveExistingPath(workspaceRoot, input);
      const targetStat = await stat(target);
      if (!targetStat.isDirectory()) throw new Error(`Not a directory: ${input}`);

      const entries = await readdir(target, { withFileTypes: true });
      const names = entries
        .filter((entry) => !entry.isSymbolicLink())
        .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
        .sort((left, right) => left.localeCompare(right));
      const visibleNames = names.slice(0, 200);
      const truncated = names.length > visibleNames.length;
      const output = visibleNames.join("\n") || "(empty directory)";
      return {
        content: [text(truncated ? `${output}\n... (more entries omitted)` : output)],
        details: { entries: visibleNames, truncated, path: relative(root, target) || "." },
      };
    },
  });

  registry.register({
    name: "read_file",
    description: "Read a UTF-8 text file inside the teaching workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Workspace-relative file path." } },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const input = requiredString(args, "path");
      const { root, target } = await resolveExistingPath(workspaceRoot, input);
      const targetStat = await stat(target);
      if (!targetStat.isFile()) throw new Error(`Not a file: ${input}`);
      if (targetStat.size > 64 * 1024) throw new Error("File is too large to read (limit: 64 KiB)");

      const contents = await readFile(target, "utf8");
      return {
        content: [text(contents)],
        details: { path: relative(root, target), bytes: targetStat.size },
      };
    },
  });

  registry.register({
    name: "write_note",
    description: "Write a Markdown note inside the workspace notes directory.",
    parameters: {
      type: "object",
      properties: {
        fileName: { type: "string", description: "A single .md file name." },
        content: { type: "string", description: "Markdown note content." },
      },
      required: ["fileName", "content"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const fileName = requiredString(args, "fileName");
      const contents = requiredString(args, "content", true);
      if (!/^[^/\\:]+\.md$/.test(fileName)) {
        throw new Error("fileName must be a single file name ending in .md");
      }
      if (Buffer.byteLength(contents, "utf8") > 16 * 1024) {
        throw new Error("Note is too large to write (limit: 16 KiB)");
      }

      const root = await realpath(workspaceRoot);
      const notesPath = resolve(root, "notes");
      await mkdir(notesPath, { recursive: true });
      const notesRoot = await realpath(notesPath);
      if (!isPathInside(root, notesRoot)) throw new Error("Notes directory escapes workspace");

      const target = resolveInsideWorkspace(notesRoot, fileName);
      try {
        const existing = await lstat(target);
        if (existing.isSymbolicLink() || !existing.isFile()) {
          throw new Error("Note target must be a regular file");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      await writeFile(target, contents, "utf8");
      return {
        content: [text(`已写入笔记：notes/${fileName}`)],
        details: { path: `notes/${fileName}`, bytes: Buffer.byteLength(contents, "utf8") },
      };
    },
  });

  return registry;
}

async function resolveExistingPath(
  workspaceRoot: string,
  input: string,
): Promise<{ root: string; target: string }> {
  const root = await realpath(workspaceRoot);
  const candidate = resolveInsideWorkspace(root, input);
  const target = await realpath(candidate);
  if (!isPathInside(root, target)) throw new Error(`Path escapes workspace: ${input}`);
  return { root, target };
}

function resolveInsideWorkspace(workspaceRoot: string, input: string): string {
  const root = resolve(workspaceRoot);
  const target = resolve(root, input);
  const rel = relative(root, target);
  if (
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    (rel === "" && input.includes(".."))
  ) {
    throw new Error(`Path escapes workspace: ${input}`);
  }
  return target;
}

function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function requiredString(
  args: Record<string, unknown>,
  name: string,
  allowEmpty = false,
): string {
  const value = args[name];
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`Tool argument '${name}' must be a${allowEmpty ? "" : " non-empty"} string`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Tool argument '${name}' must be a non-empty string`);
  }
  return value;
}