export interface CheckRepoOptions {
  runSyntaxCheck?: boolean;
}

export interface CheckRepoResult {
  ok: boolean;
  errors: string[];
  checkedFileCount: number;
}

export function checkRepo(
  rootDir: string,
  options?: CheckRepoOptions,
): CheckRepoResult;
