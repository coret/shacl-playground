import { createModel } from "@captaincodeman/rdx";

export const highlight = createModel({
  state: {
    shapesGraphHighlight: null,
    dataGraphHighlight: null,
  },
  reducers: {
    highlightShapesNode(state, sourceShape) {
      return {
        ...state,
        shapesGraphHighlight: sourceShape,
      };
    },
    highlightDataNode(state, { focusNode, resultPath }) {
      return {
        ...state,
        dataGraphHighlight: { focusNode, resultPath },
      };
    },
    clearHighlights(state) {
      return {
        ...state,
        shapesGraphHighlight: null,
        dataGraphHighlight: null,
      };
    },
  },
});
