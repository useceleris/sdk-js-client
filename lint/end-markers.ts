// House style: the closing brace of every multi-line function, method and
// class carries a marker naming it, such as `} // end method connect`.
// Loaded by .oxlintrc.json as a JS plugin; `npm run lint -- --fix` adds or
// corrects the markers.

type Position = { readonly line: number };

type Token = {
  readonly type: string;
  readonly value: string;
  readonly range: readonly [number, number];
  readonly loc: { readonly start: Position; readonly end: Position };
};

type SyntaxNode = {
  readonly type: string;
  readonly loc: { readonly start: Position; readonly end: Position };
  readonly id?: { readonly name: string } | null;
  readonly name?: string;
  readonly key?: SyntaxNode;
  readonly kind?: string;
  readonly method?: boolean;
  readonly computed?: boolean;
  readonly body?: SyntaxNode | null;
  readonly value?: SyntaxNode;
};

type SourceCode = {
  getLastToken(node: SyntaxNode): Token | null;
  getTokenAfter(token: Token, options: { includeComments: true }): Token | null;
  getText(node: SyntaxNode): string;
};

type Fixer = {
  insertTextAfter(token: Token, text: string): unknown;
  replaceText(token: Token, text: string): unknown;
};

type Context = {
  readonly sourceCode: SourceCode;
  report(problem: {
    loc: Token["loc"];
    message: string;
    fix: (fixer: Fixer) => unknown;
  }): void;
};

function keyName(sourceCode: SourceCode, node: SyntaxNode): string {
  const key = node.key!;

  if (!node.computed && key.type === "Identifier") return key.name!;

  if (key.type === "PrivateIdentifier") return `#${key.name}`;

  return sourceCode.getText(key);
} // end function keyName

function methodLabel(sourceCode: SourceCode, node: SyntaxNode): string {
  switch (node.kind) {
    case "constructor":
      return "constructor";
    case "get":
      return `getter ${keyName(sourceCode, node)}`;
    case "set":
      return `setter ${keyName(sourceCode, node)}`;
    default:
      return `method ${keyName(sourceCode, node)}`;
  }
} // end function methodLabel

function checkMarker(
  context: Context,
  body: SyntaxNode | null | undefined,
  label: string,
): void {
  if (!body || body.loc.start.line === body.loc.end.line) return;

  const sourceCode = context.sourceCode;
  const closingBrace = sourceCode.getLastToken(body);

  if (!closingBrace) return;

  // The marker follows any comma or semicolon that ends the line.
  let anchor = closingBrace;
  let next = sourceCode.getTokenAfter(anchor, { includeComments: true });

  while (
    next &&
    next.loc.start.line === anchor.loc.end.line &&
    (next.value === "," || next.value === ";")
  ) {
    anchor = next;
    next = sourceCode.getTokenAfter(anchor, { includeComments: true });
  }

  const marker = `// end ${label}`;
  const trailingComment =
    next && next.type === "Line" && next.loc.start.line === anchor.loc.end.line
      ? next
      : undefined;

  if (trailingComment && `//${trailingComment.value}`.trim() === marker) return;

  context.report({
    loc: closingBrace.loc,
    message: `Expected \`${marker}\` after this closing brace.`,
    fix: (fixer) =>
      trailingComment && /^\s*end\b/.test(trailingComment.value)
        ? fixer.replaceText(trailingComment, marker)
        : fixer.insertTextAfter(anchor, ` ${marker}`),
  });
} // end function checkMarker

const endMarkerRule = {
  meta: { type: "layout", fixable: "code" },
  create(context: Context) {
    const sourceCode = context.sourceCode;

    return {
      FunctionDeclaration(node: SyntaxNode) {
        if (node.id) {
          checkMarker(context, node.body, `function ${node.id.name}`);
        }
      }, // end method FunctionDeclaration
      ClassDeclaration(node: SyntaxNode) {
        if (node.id) checkMarker(context, node.body, `class ${node.id.name}`);
      }, // end method ClassDeclaration
      ClassExpression(node: SyntaxNode) {
        if (node.id) checkMarker(context, node.body, `class ${node.id.name}`);
      }, // end method ClassExpression
      MethodDefinition(node: SyntaxNode) {
        checkMarker(context, node.value?.body, methodLabel(sourceCode, node));
      }, // end method MethodDefinition
      Property(node: SyntaxNode) {
        if (node.method || node.kind === "get" || node.kind === "set") {
          checkMarker(context, node.value?.body, methodLabel(sourceCode, node));
        }
      }, // end method Property
    };
  }, // end method create
};

export default {
  meta: { name: "celeris" },
  rules: { "end-markers": endMarkerRule },
};
