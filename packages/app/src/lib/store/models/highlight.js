import { createModel } from "@captaincodeman/rdx";

export const highlight = createModel({
  state: {
    shapesGraphHighlight: null,
    dataGraphHighlight: null,
    timestamp: 0, // Add timestamp to force re-renders even with same values
  },
  reducers: {
    highlightShapesNode(state, sourceShape) {
      return {
        ...state,
        shapesGraphHighlight: sourceShape,
        timestamp: Date.now(), // Update timestamp on every highlight request
      };
    },
    highlightDataNode(state, { focusNode, resultPath }) {
      return {
        ...state,
        dataGraphHighlight: { focusNode, resultPath },
        timestamp: Date.now(), // Update timestamp on every highlight request
      };
    },
    clearHighlights(state) {
      return {
        ...state,
        shapesGraphHighlight: null,
        dataGraphHighlight: null,
        timestamp: Date.now(),
      };
    },
  },
});
