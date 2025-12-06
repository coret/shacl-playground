import { css, html, LitElement } from "lit";
import "@rdfjs-elements/rdf-editor";
import { connect } from "@captaincodeman/rdx";
import { shrink } from "@zazuko/prefixes/shrink";
import { store } from "../store/index.js";
import "./editor-drawer.js";

let autorefreshLoaded = null;
const PARSE_DELAY = 10;

function autoRefresh() {
  if (!autorefreshLoaded) {
    autorefreshLoaded = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src =
        "https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.32.0/addon/display/autorefresh.min.js";
      script.onload = resolve;
      document.head.appendChild(script);
    });
  }

  return autorefreshLoaded;
}

class GraphEditor extends connect(store, LitElement) {
  constructor() {
    super();
    this._highlightMarkers = [];
    this._scrollLockTimeout = null;
  }
  static get styles() {
    return css`
      :host {
        display: flex;
        flex-direction: column;
        overflow: scroll;
      }

      slot[name="header"]::slotted(*) {
        position: sticky;
        position: -webkit-sticky;
        top: 0;
        z-index: 100;
      }

      rdf-editor {
        flex: 1;
      }

      rdf-editor ::part(editor) .cm-highlight {
        background-color: yellow;
      }
    `;
  }

  static get properties() {
    return {
      format: { type: String },
      graph: { type: String },
      model: { type: String },
      prefixes: { type: Array },
      customPrefixes: { type: Object },
      highlightTerm: { type: String },
      highlightContext: { type: String },
      highlightTimestamp: { type: Number }, // Timestamp to detect highlight requests
      quads: { type: Array },
    };
  }

  async firstUpdated() {
    const editor = this.shadowRoot.querySelector("rdf-editor");
    await editor.ready;

    await autoRefresh();
    editor.codeMirror.editor.setOption("autoRefresh", true);
    this._editor = editor.codeMirror.editor;

    // Inject highlight styles directly into the CodeMirror wrapper
    const cmWrapper = editor.codeMirror.shadowRoot?.querySelector('.CodeMirror') ||
                      editor.shadowRoot?.querySelector('.CodeMirror') ||
                      editor.querySelector('.CodeMirror');

    if (cmWrapper) {
      const style = document.createElement('style');
      style.textContent = `
        .cm-highlight {
          background-color: yellow !important;
          padding: 2px 0 !important;
        }
      `;
      cmWrapper.appendChild(style);
    } else {
      console.warn('[GraphEditor] Could not find CodeMirror wrapper to inject styles for', this.model);
    }
  }

  updated(changedProperties) {
    super.updated(changedProperties);

    // Apply highlight when timestamp changes (indicates a new highlight request)
    if (changedProperties.has("highlightTimestamp") && this._editor && this.highlightTimestamp) {
      this._applyHighlight();
    }
  }

  _clearHighlights() {
    if (!this._editor) return;

    // Clear all existing markers
    this._highlightMarkers.forEach((marker) => marker.clear());
    this._highlightMarkers = [];
  }

  _findContextLines(lines, contextTerm) {
    // Find lines that contain the context (the subject/focus node)
    const contextLineIndices = [];

    // Generate alternative forms of the context
    const shrunkContext = shrink(contextTerm, this.customPrefixes) || shrink(contextTerm);
    const localPart = contextTerm.split('/').pop().split('#').pop();

    // Detect prefix from content for this namespace
    const namespace = contextTerm.substring(0, Math.max(contextTerm.lastIndexOf('/'), contextTerm.lastIndexOf('#')) + 1);
    const content = lines.join('\n');
    const prefixMatch = content.match(new RegExp(`@prefix\\s+(\\w+):\\s+<${namespace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`));
    const detectedPrefix = prefixMatch ? prefixMatch[1] : null;

    const contextTermVariants = [
      `<${contextTerm}>`, // Full IRI in angle brackets
      shrunkContext !== contextTerm ? shrunkContext : null, // Prefixed form from shrink
      detectedPrefix ? `${detectedPrefix}:${localPart}` : null, // Detected prefix form
      localPart !== contextTerm ? localPart : null, // Local part alone
    ].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i);

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];

      for (const variant of contextTermVariants) {
        // Simple check: does the line contain the variant in angle brackets or as prefixed form
        if (line.includes(`<${variant}>`) || line.includes(variant)) {
          // Verify it's at the start of the line (subject position)
          const trimmed = line.trim();
          if (trimmed.startsWith(`<${variant}>`) || trimmed.startsWith(variant)) {
            contextLineIndices.push(lineIndex);
            break;
          }
        }
      }

      // Safety: limit context lines found
      if (contextLineIndices.length > 10) {
        break;
      }
    }

    // If not found, try relaxed search
    if (contextLineIndices.length === 0) {
      const localPart = contextTerm.split('/').pop().split('#').pop();
      const shrunken = shrink(contextTerm, this.customPrefixes) || shrink(contextTerm);

      const prefixedVariants = [
        shrunken !== contextTerm ? shrunken : null,
        localPart,
        ...(localPart !== contextTerm ? [
          `oa:${localPart}`,
          `ex:${localPart}`,
          `ns:${localPart}`,
        ] : [])
      ].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i);

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const trimmed = lines[lineIndex].trim();

        if (lines[lineIndex].length > 0 && !lines[lineIndex].startsWith(' ') && !lines[lineIndex].startsWith('\t')) {
          for (const variant of prefixedVariants) {
            if (trimmed.startsWith(variant + ' ') ||
                trimmed.startsWith(variant + '\t') ||
                trimmed === variant ||
                trimmed.startsWith(`<${variant}>`) ||
                (trimmed.startsWith(variant) && trimmed[variant.length] && !trimmed[variant.length].match(/[a-zA-Z0-9_]/))) {
              contextLineIndices.push(lineIndex);
              break;
            }
          }
        }

        if (contextLineIndices.length > 10) break;
      }
    }

    return contextLineIndices;
  }

  _buildLinesToSearch(lines, contextLineIndices) {
    // For Turtle format, properties can be on the same line or indented lines following the subject
    const linesToSearch = new Set();
    contextLineIndices.forEach(lineIndex => {
      // Include the context line and several lines after it (for indented properties)
      for (let i = lineIndex; i < Math.min(lineIndex + 20, lines.length); i++) {
        linesToSearch.add(i);
        // Stop if we hit another subject (line starts at column 0 and is not whitespace/empty)
        if (i > lineIndex && lines[i].length > 0 && !lines[i].startsWith(' ') && !lines[i].startsWith('\t')) {
          const trimmed = lines[i].trim();
          if (trimmed.length > 0 && !trimmed.startsWith('@')) {
            break;
          }
        }
      }
    });
    return linesToSearch;
  }

  _isPredicatePosition(text, position, matchLength) {
    // Check if the text at this position represents an actual RDF predicate
    // by examining structural context, not just quote counting

    const matchText = text.substring(position, position + matchLength);

    // Get characters immediately before and after the match
    const before = position > 0 ? text[position - 1] : '\n';
    const after = position + matchLength < text.length ? text[position + matchLength] : '\n';

    // Get the line containing this position
    const lineStart = text.lastIndexOf('\n', position - 1) + 1;
    const lineEnd = text.indexOf('\n', position);
    const line = text.substring(lineStart, lineEnd === -1 ? text.length : lineEnd);
    const posInLine = position - lineStart;

    // Check for triple-quoted strings (multiline literals in Turtle)
    // If we're inside a triple-quoted string, this is NOT a predicate
    const beforeText = text.substring(0, position);
    const tripleQuoteCount = (beforeText.match(/"""/g) || []).length;
    if (tripleQuoteCount % 2 === 1) {
      return false; // Inside a triple-quoted literal
    }

    // For JSON-LD: Check if this is a JSON key (predicate) BEFORE rejecting as quoted string
    // Pattern: "predicate": value
    // The match itself might include the quotes or not
    if (text[position] === '"') {
      // Match includes opening quote: "schema:publisher"
      let idx = position + matchLength;
      // Skip whitespace after the match (which should end with closing quote)
      while (idx < text.length && /\s/.test(text[idx])) {
        idx++;
      }
      // If followed by colon, this is a JSON-LD key (predicate)
      if (idx < text.length && text[idx] === ':') {
        return true;
      }
    } else if (position > 0 && text[position - 1] === '"') {
      // Match is inside quotes but doesn't include the opening quote
      // Check if after the match + closing quote there's a colon
      let idx = position + matchLength;
      // Should have closing quote immediately after
      if (idx < text.length && text[idx] === '"') {
        idx++; // Skip closing quote
        // Skip whitespace
        while (idx < text.length && /\s/.test(text[idx])) {
          idx++;
        }
        // If followed by colon, this is a JSON-LD key (predicate)
        if (idx < text.length && text[idx] === ':') {
          return true;
        }
      }
    }

    // Check if we're on a line that's inside a quote (for non-JSON-LD quoted strings)
    // Count quotes before this position in the line
    let quoteCount = 0;
    for (let i = 0; i < posInLine; i++) {
      // Skip triple quotes
      if (line.substring(i, i + 3) === '"""') {
        i += 2; // Will be incremented by loop
        continue;
      }
      if (line[i] === '"' && (i === 0 || line[i - 1] !== '\\')) {
        quoteCount++;
      }
    }

    // If odd number of quotes before position, we're inside a quoted string
    if (quoteCount % 2 === 1) {
      return false;
    }

    // For Turtle/Trig: predicates appear in specific structural positions
    // They should be:
    // 1. Preceded by whitespace, newline, semicolon (for continuing triples), or start
    // 2. Followed by whitespace (then the object)

    const validBefore = /[\s\n;{]/.test(before) || position === 0;
    const validAfter = /[\s\n]/.test(after);

    // Additionally, predicates should NOT be inside angle brackets < > for IRI references
    // unless they ARE the angle brackets themselves
    const isFullIRI = text[position] === '<' && text[position + matchLength - 1] === '>';

    const result = (validBefore && validAfter) || isFullIRI;

    return result;
  }

  _getPredicateStringsFromQuads(searchTerm, contextTerm = null) {
    // Find all predicates in the RDF quads that match the search term
    const predicateStrings = new Set();

    if (!this.quads || !Array.isArray(this.quads)) {
      return predicateStrings;
    }

    for (const quad of this.quads) {
      // Check if the predicate matches our search term
      const predicateValue = quad.predicate?.value;
      if (!predicateValue) continue;

      // Match if predicate equals search term
      if (predicateValue === searchTerm) {
        // If we have a context (subject filter), only include if subject matches
        if (contextTerm) {
          const subjectValue = quad.subject?.value;
          if (subjectValue !== contextTerm) {
            continue;
          }
        }

        // Add various forms of the predicate that might appear in the serialization
        // Only add full IRI in angle brackets or prefixed form, NOT local part alone
        predicateStrings.add(`<${predicateValue}>`); // Full IRI in angle brackets

        const shrunk = shrink(predicateValue, this.customPrefixes) || shrink(predicateValue);
        if (shrunk && shrunk !== predicateValue) {
          predicateStrings.add(shrunk); // Prefixed form (e.g., schema:publisher)
        }

        // For JSON-LD, add with quotes
        predicateStrings.add(`"${predicateValue}"`);
        if (shrunk && shrunk !== predicateValue) {
          predicateStrings.add(`"${shrunk}"`);
        }
      }
    }

    return predicateStrings;
  }

  _findAndHighlightShapePath(content, doc, searchTerm, contextTerm, lines) {
    // Find sh:path statements with the searchTerm as the object value
    // within the context of a specific shape (contextTerm)
    const matches = [];
    let contextLinePosition = null;

    // First, find the shape definition (context)
    const contextLineIndices = this._findContextLines(lines, contextTerm);

    if (contextLineIndices.length === 0) {
      return { matches, contextLinePosition: null };
    }

    // Store context line position for scrolling
    if (contextLineIndices.length > 0) {
      let charOffset = 0;
      for (let i = 0; i < contextLineIndices[0]; i++) {
        charOffset += lines[i].length + 1;
      }
      contextLinePosition = doc.posFromIndex(charOffset);
    }

    // Build set of lines to search within the shape context
    const linesToSearch = this._buildLinesToSearch(lines, contextLineIndices);

    // Generate search variants for the path value
    const shrunkForm = shrink(searchTerm, this.customPrefixes) || shrink(searchTerm);

    // Fallback: try common prefixes if shrink didn't work
    const localPart = searchTerm.split('/').pop().split('#').pop();
    let alternativeForms = [];
    if ((!shrunkForm || shrunkForm === searchTerm || shrunkForm.trim() === '') && searchTerm.includes('schema.org')) {
      alternativeForms = [`schema:${localPart}`, `sdo:${localPart}`];
    }


    const searchVariants = [
      `sh:path <${searchTerm}>`,
      shrunkForm && shrunkForm !== searchTerm && shrunkForm.trim() !== '' ? `sh:path ${shrunkForm}` : null,
      ...alternativeForms.map(form => `sh:path ${form}`),
      `<http://www.w3.org/ns/shacl#path> <${searchTerm}>`,
      shrunkForm && shrunkForm !== searchTerm && shrunkForm.trim() !== '' ? `<http://www.w3.org/ns/shacl#path> ${shrunkForm}` : null,
      ...alternativeForms.map(form => `<http://www.w3.org/ns/shacl#path> ${form}`),
    ].filter(Boolean);


    // Search within context lines
    let charOffset = 0;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];

      if (linesToSearch.has(lineIndex)) {
        for (const variant of searchVariants) {
          const foundIndex = line.indexOf(variant);
          if (foundIndex !== -1) {
            // Determine what part to highlight (the property value after sh:path)
            // Variants look like: "sh:path <URI>" or "sh:path schema:publisher"
            // We want to highlight the part AFTER "sh:path " or after the full SHACL predicate
            let valueString;
            let valueStart;

            // Check which type of variant this is
            if (variant.startsWith('sh:path ')) {
              valueString = variant.substring('sh:path '.length);
              valueStart = variant.indexOf(valueString);
            } else if (variant.startsWith('<http://www.w3.org/ns/shacl#path> ')) {
              valueString = variant.substring('<http://www.w3.org/ns/shacl#path> '.length);
              valueStart = variant.indexOf(valueString);
            } else {
              console.warn('[_findAndHighlightShapePath] Unknown variant format:', variant);
              continue;
            }


            if (valueStart === -1 || !valueString) {
              console.warn('[_findAndHighlightShapePath] Could not find value in variant, skipping');
              continue;
            }

            const globalIndex = charOffset + foundIndex + valueStart;
            const from = doc.posFromIndex(globalIndex);
            const to = doc.posFromIndex(globalIndex + valueString.length);


            const marker = doc.markText(from, to, {
              className: "cm-highlight",
            });

            this._highlightMarkers.push(marker);
            matches.push(from);
            break;
          }
        }
      }

      charOffset += line.length + 1; // +1 for newline
    }


    return { matches, contextLinePosition };
  }

  _findAndHighlightSubject(content, doc, searchTerm) {
    // Find and highlight a subject (shape node) - it appears at the start of lines
    const matches = [];
    const lines = content.split('\n');

    // Generate search variants for the subject
    const shrunkForm = shrink(searchTerm, this.customPrefixes) || shrink(searchTerm);
    const localPart = searchTerm.split('/').pop().split('#').pop();

    // Try to detect the prefix from the content
    // Look for @prefix declarations that match our namespace
    const namespace = searchTerm.substring(0, searchTerm.lastIndexOf('#') + 1);
    const prefixMatch = content.match(new RegExp(`@prefix\\s+(\\w+):\\s+<${namespace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`));
    const detectedPrefix = prefixMatch ? prefixMatch[1] : null;

    const subjectVariants = [
      `<${searchTerm}>`, // Full IRI in angle brackets
      shrunkForm !== searchTerm ? shrunkForm : null, // Prefixed form from shrink
      detectedPrefix ? `${detectedPrefix}:${localPart}` : null, // Detected prefix form
      localPart !== searchTerm ? localPart : null, // Local part alone
    ].filter(Boolean);


    let charOffset = 0;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const trimmed = line.trim();

      // Check if this line starts with one of our subject variants
      for (const variant of subjectVariants) {
        if (trimmed.startsWith(variant + ' ') ||
            trimmed.startsWith(variant + '\t') ||
            trimmed === variant) {

          const foundIndex = line.indexOf(variant);
          const globalIndex = charOffset + foundIndex;
          const from = doc.posFromIndex(globalIndex);
          const to = doc.posFromIndex(globalIndex + variant.length);


          const marker = doc.markText(from, to, {
            className: "cm-highlight",
          });

          this._highlightMarkers.push(marker);
          matches.push(from);
          break; // Only match once per line
        }
      }

      charOffset += line.length + 1; // +1 for newline
    }

    return matches;
  }

  _findAndHighlight(content, doc, searchTerm) {
    const matches = [];

    // Get the actual predicate strings from RDF quads (format-agnostic)
    const predicateStrings = this._getPredicateStringsFromQuads(searchTerm);

    if (predicateStrings.size === 0) {
      // Fallback to old search if no quads available
      return this._findAndHighlightFallback(content, doc, searchTerm);
    }

    // Count how many times this predicate actually appears in the RDF
    let predicateCount = 0;
    if (this.quads && Array.isArray(this.quads)) {
      for (const quad of this.quads) {
        if (quad.predicate?.value === searchTerm) {
          predicateCount++;
        }
      }
    }

    // Find all occurrences and filter out those inside literals
    const candidateOccurrences = [];

    for (const predicateString of predicateStrings) {
      let index = 0;
      let foundCount = 0;

      while (index < content.length) {
        const foundIndex = content.indexOf(predicateString, index);
        if (foundIndex === -1) break;

        foundCount++;
        // Check if this occurrence is actually a predicate (not inside a literal)
        const isValidPredicate = this._isPredicatePosition(content, foundIndex, predicateString.length);

        if (isValidPredicate) {
          candidateOccurrences.push({
            index: foundIndex,
            length: predicateString.length,
            string: predicateString,
          });
        }

        index = foundIndex + predicateString.length;
      }
    }

    // Sort by position and take only up to predicateCount
    candidateOccurrences.sort((a, b) => a.index - b.index);
    const toHighlight = predicateCount > 0 ?
      candidateOccurrences.slice(0, predicateCount) :
      candidateOccurrences;

    // Highlight the selected occurrences
    for (const occurrence of toHighlight) {
      const from = doc.posFromIndex(occurrence.index);
      const to = doc.posFromIndex(occurrence.index + occurrence.length);

      const marker = doc.markText(from, to, {
        className: "cm-highlight",
      });

      this._highlightMarkers.push(marker);
      matches.push(from);
    }

    return matches;
  }

  _findAndHighlightFallback(content, doc, searchTerm) {
    // Fallback for when quads not available - try multiple variants for all formats
    const shrunkForm = shrink(searchTerm, this.customPrefixes) || shrink(searchTerm);
    const localPart = searchTerm.split('/').pop().split('#').pop();

    // Try common prefixes if shrink didn't work
    const prefixedForms = [];
    if (!shrunkForm || shrunkForm === searchTerm) {
      // Try common schema.org prefixes
      if (searchTerm.includes('schema.org')) {
        prefixedForms.push(`schema:${localPart}`);
        prefixedForms.push(`sdo:${localPart}`);
      }
      // Try common dublin core prefixes
      if (searchTerm.includes('purl.org/dc')) {
        prefixedForms.push(`dc:${localPart}`);
        prefixedForms.push(`dct:${localPart}`);
      }
    }

    // Build variants for different serialization formats
    const baseVariants = [
      shrunkForm !== searchTerm ? shrunkForm : null,  // e.g., "schema:publisher"
      ...prefixedForms,  // Common prefixed forms
    ].filter(Boolean);

    const searchVariants = [
      ...baseVariants,  // Turtle/Trig: schema:publisher
      ...baseVariants.map(v => `"${v}"`),  // JSON-LD: "schema:publisher"
      `<${searchTerm}>`,  // Turtle/Trig: <https://schema.org/publisher>
      `"${searchTerm}"`,  // JSON-LD: "https://schema.org/publisher"
    ].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i);

    const matches = [];

    for (const variant of searchVariants) {
      let index = 0;
      let foundCount = 0;
      let validCount = 0;

      while (index < content.length) {
        const foundIndex = content.indexOf(variant, index);
        if (foundIndex === -1) break;

        foundCount++;

        // Check if this is actually a predicate position (not inside a literal)
        const isValidPredicate = this._isPredicatePosition(content, foundIndex, variant.length);

        if (isValidPredicate) {
          validCount++;
          const from = doc.posFromIndex(foundIndex);
          const to = doc.posFromIndex(foundIndex + variant.length);

          const marker = doc.markText(from, to, {
            className: "cm-highlight",
          });

          this._highlightMarkers.push(marker);
          matches.push(from);
        }

        index = foundIndex + variant.length;
      }
    }

    return matches;
  }

  _findAndHighlightInContext(content, doc, searchTerm, contextTerm) {
    const matches = [];
    let contextLinePosition = null;
    const lines = content.split('\n');


    // For shapes graph, searchTerm is the sh:path value (object), not a predicate
    // For data graph, searchTerm is a predicate
    const isShapesGraph = this.model === 'shapesGraph';

    if (isShapesGraph) {
      // In shapes graph, we need to find sh:path statements with this value
      // Look for patterns like: sh:path <searchTerm> or sh:path schema:publisher
      return this._findAndHighlightShapePath(content, doc, searchTerm, contextTerm, lines);
    }

    // Data graph logic: Get the actual predicate strings from RDF quads with subject filter
    const predicateStrings = this._getPredicateStringsFromQuads(searchTerm, contextTerm);

    if (predicateStrings.size > 0) {
      // Find the lines containing the context (focusNode) to limit search scope
      const contextLineIndices = this._findContextLines(lines, contextTerm);

      if (contextLineIndices.length === 0) {
        // Continue to fallback below
      } else {
        // Store context line position for scrolling
        if (contextLineIndices.length > 0) {
          let charOffset = 0;
          for (let i = 0; i < contextLineIndices[0]; i++) {
            charOffset += lines[i].length + 1;
          }
          contextLinePosition = doc.posFromIndex(charOffset);
        }

        // Build set of lines to search within the context
        const linesToSearch = this._buildLinesToSearch(lines, contextLineIndices);

        // Search within context lines only
        let charOffset = 0;
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
          const line = lines[lineIndex];

          if (linesToSearch.has(lineIndex)) {
            for (const predicateString of predicateStrings) {
              let colIndex = 0;

              while (colIndex < line.length) {
                const foundIndex = line.indexOf(predicateString, colIndex);
                if (foundIndex === -1) break;

                const globalIndex = charOffset + foundIndex;

                // Check if this occurrence is actually a predicate (not inside a literal)
                const isValidPredicate = this._isPredicatePosition(content, globalIndex, predicateString.length);

                if (isValidPredicate) {
                  const from = doc.posFromIndex(globalIndex);
                  const to = doc.posFromIndex(globalIndex + predicateString.length);

                  const marker = doc.markText(from, to, {
                    className: "cm-highlight",
                  });

                  this._highlightMarkers.push(marker);
                  matches.push(from);
                }

                colIndex = foundIndex + predicateString.length;
              }
            }
          }

          charOffset += line.length + 1; // +1 for newline
        }

        // If we found matches, return them with context line
        if (matches.length > 0) {
          return { matches, contextLinePosition };
        }
      }
    }

    // Fallback: use the old text-based contextual search
    // (lines already declared at top of function)

    // Safety check - bail if document is too large
    if (lines.length > 10000) {
      return { matches, contextLinePosition: null };
    }

    // Generate alternative forms of the search term for all formats
    const shrunkenSearch = shrink(searchTerm, this.customPrefixes) || shrink(searchTerm);
    const searchLocalPart = searchTerm.split('/').pop().split('#').pop();

    // Try common prefixes if shrink didn't work
    const prefixedForms = [];
    if (!shrunkenSearch || shrunkenSearch === searchTerm) {
      if (searchTerm.includes('schema.org')) {
        prefixedForms.push(`schema:${searchLocalPart}`);
        prefixedForms.push(`sdo:${searchLocalPart}`);
      }
      if (searchTerm.includes('purl.org/dc')) {
        prefixedForms.push(`dc:${searchLocalPart}`);
        prefixedForms.push(`dct:${searchLocalPart}`);
      }
    }

    // Build variants for different serialization formats
    const baseVariants = [
      shrunkenSearch !== searchTerm ? shrunkenSearch : null,
      ...prefixedForms,
    ].filter(Boolean);

    const searchTermVariants = [
      ...baseVariants,  // Turtle/Trig: schema:publisher
      ...baseVariants.map(v => `"${v}"`),  // JSON-LD: "schema:publisher"
      `<${searchTerm}>`,  // Turtle/Trig: <https://schema.org/publisher>
      `"${searchTerm}"`,  // JSON-LD: "https://schema.org/publisher"
    ].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i);

    // For context, we want to be more precise - prioritize exact matches
    const contextTermVariants = [
      contextTerm, // Full IRI first
      shrink(contextTerm, this.customPrefixes) || shrink(contextTerm), // Then prefixed
      contextTerm.split('/').pop(), // Local part after last /
      contextTerm.split('#').pop(), // Local part after #
    ].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i);

    // Find lines that contain the context (the subject/focus node)
    const contextLineIndices = this._findContextLines(lines, contextTerm);

    if (contextLineIndices.length === 0) {
      return { matches, contextLinePosition: null };
    }

    // Store context line position for scrolling (if not already set by RDF-based search)
    if (!contextLinePosition && contextLineIndices.length > 0) {
      let charOffset = 0;
      for (let i = 0; i < contextLineIndices[0]; i++) {
        charOffset += lines[i].length + 1;
      }
      contextLinePosition = doc.posFromIndex(charOffset);
    }

    // Build set of lines to search within the context
    const linesToSearch = this._buildLinesToSearch(lines, contextLineIndices);

    // Now search for the property within these lines
    let charOffset = 0;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];

      if (linesToSearch.has(lineIndex)) {
        for (const searchVariant of searchTermVariants) {
          let colIndex = 0;
          let safetyCounter = 0;

          while (colIndex < line.length && safetyCounter < 100) {
            safetyCounter++;
            const foundIndex = line.indexOf(searchVariant, colIndex);
            if (foundIndex === -1) break;

            const globalIndex = charOffset + foundIndex;

            // Check if this is actually a predicate position (not inside a literal)
            if (this._isPredicatePosition(content, globalIndex, searchVariant.length)) {
              const from = doc.posFromIndex(globalIndex);
              const to = doc.posFromIndex(globalIndex + searchVariant.length);

              const marker = doc.markText(from, to, {
                className: "cm-highlight",
              });

              this._highlightMarkers.push(marker);
              matches.push(from);
            }

            colIndex = foundIndex + searchVariant.length;
          }
        }
      }

      charOffset += line.length + 1; // +1 for newline
    }

    // If no matches found for the property, highlight the context (subject IRI) as fallback
    if (matches.length === 0 && contextLineIndices.length > 0) {

      for (const contextLineIndex of contextLineIndices) {
        const line = lines[contextLineIndex];

        // Calculate the character offset up to this line
        let offsetToLine = 0;
        for (let i = 0; i < contextLineIndex; i++) {
          offsetToLine += lines[i].length + 1; // +1 for newline
        }

        // Find the subject in the line and highlight it
        for (const variant of contextTermVariants) {
          const foundIndex = line.indexOf(variant);
          if (foundIndex !== -1) {
            const globalIndex = offsetToLine + foundIndex;
            const from = doc.posFromIndex(globalIndex);
            const to = doc.posFromIndex(globalIndex + variant.length);

            const marker = doc.markText(from, to, {
              className: "cm-highlight",
            });

            this._highlightMarkers.push(marker);
            matches.push(from);
            break;
          }
        }
      }
    }

    return { matches, contextLinePosition };
  }

  _applyHighlight() {
    this._clearHighlights();


    if (!this.highlightTerm || !this._editor) {
      return;
    }

    const doc = this._editor.getDoc();
    const searchTerm = this.highlightTerm;
    const contextTerm = this.highlightContext;
    const content = doc.getValue();


    // If we have a context (for data graph OR shapes graph), find matches within context
    if (contextTerm) {
      const result = this._findAndHighlightInContext(content, doc, searchTerm, contextTerm);
      const { matches, contextLinePosition } = result;


      // Scroll to show the first highlighted match (property)
      if (matches.length > 0) {
        // For lines near the top (0-10), use smaller margin
        // For other lines, use normal margin to keep match centered
        const matchLine = matches[0].line;
        const matchCh = matches[0].ch;
        const margin = matchLine < 10 ? 20 : 100;

        // Cancel any pending scroll from previous clicks
        if (this._scrollLockTimeout) {
          clearTimeout(this._scrollLockTimeout);
          this._scrollLockTimeout = null;
        }

        // Store the target position to maintain it across updates
        this._targetScrollPosition = matches[0];

        // First, set cursor WITHOUT auto-scrolling
        this._editor.setCursor(matches[0], null, { scroll: false });

        // Scroll to show the target line below the sticky header
        // Use a small delay to ensure CodeMirror has rendered
        const performScroll = () => {
          // Get the line element's position in the page
          const coords = this._editor.charCoords(matches[0], "page");
          const editorWrapper = this._editor.getWrapperElement();
          const editorRect = editorWrapper.getBoundingClientRect();
          const container = this; // The graph-editor custom element (this component)

          const headerHeight = 70; // Height of sticky header
          const marginBelowHeader = 20; // Extra margin below header

          // Calculate where the line is relative to the editor wrapper
          const lineTopInEditor = coords.top - editorRect.top;

          // Calculate target scroll: position line just below the header
          const targetScrollTop = lineTopInEditor - headerHeight - marginBelowHeader;

          // Scroll the container (this component) not CodeMirror
          if (targetScrollTop < 0) {
            // Line is near top, scroll to top
            container.scrollTop = 0;
          } else {
            // Scroll container to show line below header
            container.scrollTop = targetScrollTop;
          }
        };

        // Perform scroll multiple times to ensure it sticks
        setTimeout(() => {
          performScroll();
        }, 50);
        setTimeout(() => {
          performScroll();
        }, 100);
        this._scrollLockTimeout = setTimeout(() => {
          performScroll();
          this._scrollLockTimeout = null;
        }, 200);
      }
    } else {
      // No context, highlight all occurrences (for shapes graph)
      // This can be either a shape node (subject) or a predicate
      let matches = [];

      // First, try to find as a subject (shape node) - look for it at the start of lines
      matches = this._findAndHighlightSubject(content, doc, searchTerm);

      // If not found as subject, try as predicate
      if (matches.length === 0) {
        matches = this._findAndHighlight(content, doc, searchTerm);

        // If no matches found, try the prefixed version
        if (matches.length === 0) {
          const prefixedTerm = shrink(searchTerm, this.customPrefixes) || shrink(searchTerm);
          if (prefixedTerm && prefixedTerm !== searchTerm) {
            matches = this._findAndHighlight(content, doc, prefixedTerm);
          }
        }

        // If still no matches with full prefixed format, try just the local part
        if (matches.length === 0 && searchTerm.includes('/')) {
          const localPart = searchTerm.split('/').pop();
          if (localPart) {
            matches = this._findAndHighlight(content, doc, localPart);
          }
        }

        // If still no matches with full prefixed format, try just the local part after #
        if (matches.length === 0 && searchTerm.includes('#')) {
          const localPart = searchTerm.split('#').pop();
          if (localPart) {
            matches = this._findAndHighlight(content, doc, localPart);
          }
        }
      }

      // If we found at least one match, scroll to the first one
      if (matches.length > 0) {

        // Cancel any pending scroll lock from previous clicks
        if (this._scrollLockTimeout) {
          clearTimeout(this._scrollLockTimeout);
          this._scrollLockTimeout = null;
        }

        // Store the target position to maintain it across updates
        this._targetScrollPosition = matches[0];

        // First, set cursor WITHOUT auto-scrolling
        this._editor.setCursor(matches[0], null, { scroll: false });

        // Scroll to show the target line below the sticky header
        // Use a small delay to ensure CodeMirror has rendered
        const performScroll = () => {
          // Get the line element's position in the page
          const coords = this._editor.charCoords(matches[0], "page");
          const editorWrapper = this._editor.getWrapperElement();
          const editorRect = editorWrapper.getBoundingClientRect();
          const container = this; // The graph-editor custom element (this component)

          const headerHeight = 70; // Height of sticky header
          const marginBelowHeader = 20; // Extra margin below header

          // Calculate where the line is relative to the editor wrapper
          const lineTopInEditor = coords.top - editorRect.top;

          // Calculate target scroll: position line just below the header
          const targetScrollTop = lineTopInEditor - headerHeight - marginBelowHeader;

          // Scroll the container (this component) not CodeMirror
          if (targetScrollTop < 0) {
            // Line is near top, scroll to top
            container.scrollTop = 0;
          } else {
            // Scroll container to show line below header
            container.scrollTop = targetScrollTop;
          }
        };

        // Perform scroll multiple times to ensure it sticks
        setTimeout(performScroll, 50);
        setTimeout(performScroll, 100);
        this._scrollLockTimeout = setTimeout(() => {
          performScroll();
          this._scrollLockTimeout = null;
        }, 200);
      }
    }
  }

  render() {
    return html`
      <slot name="header"></slot>
      <rdf-editor
        .format="${this.format}"
        .value="${this.graph}"
        auto-parse
        .parseDelay="${PARSE_DELAY}"
        .prefixes="${this.prefixes.join(",")}"
        .customPrefixes="${this.customPrefixes}"
        @quads-changed="${this.__quadsChanged}"
        @focus="${(e) => this.__forwardEvent(e)}"
        @blur="${(e) => this.__forwardEvent(e)}"
      ></rdf-editor>
    `;
  }

  __forwardEvent(e) {
    this.dispatchEvent(new Event(e.type));
  }

  __quadsChanged(e) {
    store.dispatch[this.model].parsed({
      quads: e.detail.value,
      serialized: e.target.value,
    });
  }

  mapState(state) {
    let highlightTerm = null;
    let highlightContext = null;

    // Determine what to highlight based on the model (shapes or data graph)
    if (this.model === "shapesGraph" && state.highlight.shapesGraphHighlight) {
      const highlight = state.highlight.shapesGraphHighlight;

      // Check if it's an object with sourceShape and resultPath
      if (typeof highlight === 'object' && highlight.sourceShape && highlight.resultPath) {
        highlightTerm = highlight.resultPath;
        highlightContext = highlight.sourceShape;
      } else {
        // Legacy format: just a string (the term to highlight)
        highlightTerm = highlight;
      }
    } else if (this.model === "dataGraph" && state.highlight.dataGraphHighlight) {
      const { focusNode, resultPath } = state.highlight.dataGraphHighlight;
      // For data graph, we need to highlight the property in context of the specific subject
      highlightTerm = resultPath;
      highlightContext = focusNode;
    }

    return {
      format: state[this.model].format,
      prefixes: state[this.model].prefixes,
      customPrefixes: state[this.model].customPrefixes || {},
      graph: state[this.model].graph,
      quads: state[this.model].quads,
      highlightTerm,
      highlightContext,
      highlightTimestamp: state.highlight.timestamp, // Include timestamp
    };
  }
}

customElements.define("graph-editor", GraphEditor);
