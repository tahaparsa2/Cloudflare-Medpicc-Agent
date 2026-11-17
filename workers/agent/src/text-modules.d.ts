// Files bundled as text: the context file and the fixture transcripts.
declare module "*.md" {
  const text: string;
  export default text;
}
declare module "*.txt" {
  const text: string;
  export default text;
}
