import { expect, test } from "bun:test";
import { evaluateExample, type ExampleBounds } from "./src/rangeWalkthrough";

const initial: ExampleBounds = {lower:"10",upper:"20",lowerBoundary:"inclusive",upperBoundary:"exclusive"};
const matches = (bounds: ExampleBounds) => evaluateExample(bounds).values.filter(item => item.matches).map(item => item.value);

test("educational boundary model includes only values within both bounds", () => {
  expect(matches(initial)).toEqual([10,15]);
  expect(matches({...initial,upperBoundary:"inclusive"})).toEqual([10,15,20]);
  expect(matches({...initial,lowerBoundary:"exclusive"})).toEqual([15]);
  expect(matches({...initial,lower:"20",upperBoundary:"unbounded",lowerBoundary:"exclusive"})).toEqual([21]);
  expect(matches({...initial,lowerBoundary:"unbounded"})).toEqual([9,10,15]);
});

test("educational empty intervals follow the complete range API semantics", () => {
  expect(matches({...initial,lowerBoundary:"exclusive",upper:"15"})).toEqual([]);
  expect(matches({...initial,lower:"20",upper:"10"})).toEqual([]);
  expect(matches({...initial,upper:"10",upperBoundary:"inclusive"})).toEqual([10]);
  expect(matches({...initial,upper:"10"})).toEqual([]);
  expect(evaluateExample({...initial,lower:"20",upper:"10"}).error).toBe("");
});

test("invalid educational inputs never manufacture an empty answer", () => {
  expect(evaluateExample({...initial,lower:""}).error).toBeTruthy();
  expect(evaluateExample({...initial,lower:"1.5"}).error).toBeTruthy();
  expect(evaluateExample({...initial,lowerBoundary:"unbounded",upperBoundary:"unbounded"}).error).toBeTruthy();
  expect(evaluateExample({...initial,lower:"9007199254740993",upperBoundary:"unbounded"}).error).toBe("");
  expect(matches({...initial,lower:"9007199254740993",upperBoundary:"unbounded"})).toEqual([]);
});
