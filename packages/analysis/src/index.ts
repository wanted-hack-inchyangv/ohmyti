export const PACKAGE_NAME = "@ohmyti/analysis" as const;

export {
  buildCallGraph,
  CallGraphBuilder,
  type CallGraph,
  type GraphCallEdge,
  type GraphFunction,
  type RouteRegistration,
} from "./call-graph";
export {
  analyzeFunctionGraph,
  clipSnippet,
  SNIPPET_MAX_CHARS,
  SNIPPET_MAX_LINES,
  SyntaxErrorsFound,
  type AnalyzeFunctionGraphInput,
  type AnalyzeFunctionGraphResult,
} from "./function-graph";
export {
  filesFromEntries,
  runIsolatedAnalysis,
  type IsolatedAnalysisInput,
  type IsolatedAnalysisResult,
} from "./child";
export {
  analyzeFunctionGraphIsolated,
  CHILD_BUNDLE_NAME,
  CHILD_SOURCE_NAME,
  childEntry,
  ISOLATED_DEFAULTS,
  type IsolatedOptions,
} from "./isolated";
export {
  assertSafeRelativePath,
  InvalidSnapshotPathError,
  isSourcePath,
  PROJECT_LIMIT_DEFAULTS,
  ProjectLimitError,
  relativeSourcePath,
  SOURCE_EXTENSIONS,
  withSnapshotProject,
  type AnalysisFiles,
  type LoadedProject,
  type LoadProjectOptions,
  type ProjectLimits,
} from "./project";
export {
  findMatchingRoute,
  joinRoutePath,
  matchRoutePath,
  methodMatches,
  normalizeRequestPath,
  ROUTE_METHOD_NAMES,
} from "./routes";
export { buildCaseSubgraph, type CaseInput, type CaseRequestInput } from "./subgraph";
export * from "./mutation";
