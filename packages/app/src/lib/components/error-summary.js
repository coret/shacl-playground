import { html, LitElement, css } from "lit";
import { shrink } from "@zazuko/prefixes/shrink";
import rdf from "../env.js";
import { store } from "../store/index.js";

function createMessage(result) {
  try {
    if (result.resultMessage) {
      // Get all messages if multiple exist
      const messages = Array.isArray(result.resultMessage)
        ? result.resultMessage
        : [result.resultMessage];
      return messages.join('; ');
    }
  } catch (e) {
    // Handle multiple resultMessage values by accessing the raw RDF data
    const messages = result.pointer.out(rdf.ns.sh.resultMessage).values;
    if (messages.length > 0) {
      return messages.join('; ');
    }
  }

  if (result.sourceConstraintComponent) {
    return `Violated ${shrink(result.sourceConstraintComponent.id.value)}`;
  }

  return "Unspecified error";
}

const handleErrorClick = (result) => {
  // Directly set new highlights without clearing first
  // This prevents the double-update that causes scroll jumping

  // For shapes graph, use resultPath (the property that violated the constraint)
  if (result.resultPath) {
    const resultPathValue = result.resultPath?.id?.value || result.resultPath?.value;
    store.dispatch.highlight.highlightShapesNode(resultPathValue);
  } else if (result.sourceConstraintComponent) {
    // Fallback to constraint component
    const constraintValue = result.sourceConstraintComponent?.id?.value || result.sourceConstraintComponent?.value;
    store.dispatch.highlight.highlightShapesNode(constraintValue);
  }

  // Highlight data graph node if focusNode exists
  if (result.focusNode) {
    const focusNodeValue = result.focusNode.value;
    const resultPathValue = result.resultPath?.id?.value || result.resultPath?.value || null;
    store.dispatch.highlight.highlightDataNode({
      focusNode: focusNodeValue,
      resultPath: resultPathValue,
    });
  }
};

const renderResult = (result) => html`
  <li>
    <a
      href="#"
      class="error-link"
      @click="${(e) => {
        e.preventDefault();
        handleErrorClick(result);
      }}"
    >
      ${createMessage(result)}
    </a>
  </li>
`;

function renderSummary({ focusNodes, ...top }, customPrefixes) {
  return html`
    <ul>
      ${top.errors.map(renderResult)}
      ${[...focusNodes].map(
        ([focusNode, { properties, errors }]) => html`
          <li>
            ${shrink(focusNode.value, customPrefixes) || focusNode.value}:
            <ul>
              ${errors.map(renderResult)}
              ${[...properties].map(
                ([property, messages]) => html`
                  <li>
                    ${shrink(property.value, customPrefixes) || property.value}:
                    <ul>
                      ${messages.map(renderResult)}
                    </ul>
                  </li>
                `
              )}
            </ul>
          </li>
        `
      )}
    </ul>
  `;
}

function reduceToFocusNodes({ focusNodes, errors }, result) {
  if (result.focusNode) {
    const focusNodeErrors = focusNodes.get(result.focusNode) || {
      properties: rdf.termMap(),
      errors: [],
    };
    if (result.resultPath) {
      const pathErrors = focusNodeErrors.properties.get(result.resultPath.id);
      if (pathErrors) {
        pathErrors.push(result);
      } else {
        focusNodeErrors.properties.set(result.resultPath.id, [result]);
      }
    } else {
      focusNodeErrors.errors.push(result);
    }

    focusNodes.set(result.focusNode, focusNodeErrors);
  } else {
    errors.push(result);
  }

  return { focusNodes, errors };
}

class ErrorSummary extends LitElement {
  static get styles() {
    return css`
      .error-link {
        color: inherit;
        text-decoration: none;
        cursor: pointer;
        display: block;
        padding: 0.25em;
        outline: none;
        border-radius: 0.25em;
      }

      .error-link:hover {
        background-color: var(--lumo-primary-color-10pct); // not nice in respect to depencies
      }
    `;
  }

  static get properties() {
    return {
      validationResults: { type: Array },
      customPrefixes: { type: Object },
    };
  }

  constructor() {
    super();
    this.validationResults = [];
    this.customPrefixes = {};
  }

  render() {
    const results = this.validationResults
      .map((result) => rdf.rdfine.sh.ValidationResult(result))
      .filter((result) => result.resultSeverity.equals(rdf.ns.sh.Violation));

    if (results.length) {
      const summary = results.reduce(reduceToFocusNodes, {
        focusNodes: rdf.termMap(),
        errors: [],
      });
      return renderSummary(summary, this.customPrefixes);
    }

    return "";
  }
}

customElements.define("error-summary", ErrorSummary);