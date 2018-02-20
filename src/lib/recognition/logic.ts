import { createModelForFace, recognize } from "../api";
// TODO feels a bit nasty to refer to the event type from here
import { IDetection, IFaceRect } from "../../utils/withTracking";
import { loop, Cmd } from "redux-loop";
import { crop } from "../../utils/image";
import { getBestImageFromBuffer } from "./utils";

const FACE_BUFFER_SIZE = 9;

export type Action =
  | IFacesRecognisedAction
  | IFaceRecognitionFailedAction
  | IFaceReappearedAction
  | IFaceDetectedAction
  | IFacesDetectedAction
  | IFaceSavedAction
  | IToggleTrackingAction
  | IImageToBeBufferedAction
  | ISubmitFaceAction;

export enum TypeKeys {
  FACE_DETECTED = "recognition/FACE_DETECTED",
  FACES_DETECTED = "recognition/FACES_DETECTED",
  FACE_RECOGNISED = "recognition/FACE_RECOGNISED",
  FACES_AMOUNT_CHANGED = "recognition/FACES_AMOUNT_CHANGED",
  FACE_SAVED = "recognition/FACE_SAVED",
  FACE_RECOGNITION_FAILED = "recognition/FACE_RECOGNITION_FAILED",
  FACE_REAPPEARED = "recognition/FACE_REAPPEARED",
  SUBMIT_FACE = "recognition/SUBMIT_FACE",
  DEBUG_TOGGLE_TRACKING = "recognition/DEBUG_TOGGLE_TRACKING",
  IMAGE_RECEIVED_FOR_BUFFERING = "recognition/IMAGE_RECEIVED_FOR_BUFFERING"
}

interface IFaceDetectedAction {
  type: TypeKeys.FACE_DETECTED;
  payload: { image: string };
}

interface IFacesDetectedAction {
  type: TypeKeys.FACES_DETECTED;
  payload: { detection: IDetection };
}

export function facesDetected(detection: IDetection): IFacesDetectedAction {
  return {
    type: TypeKeys.FACES_DETECTED,
    payload: { detection }
  };
}

interface IFacesRecognisedAction {
  type: TypeKeys.FACE_RECOGNISED;
  payload: { names: string[] };
}

function facesRecognised(names: string[]): Action {
  return {
    type: TypeKeys.FACE_RECOGNISED,
    payload: { names }
  };
}

interface IFaceRecognitionFailedAction {
  type: TypeKeys.FACE_RECOGNITION_FAILED;
  payload: { error: Error };
}

function faceRecognitionFailed(error: Error): Action {
  return {
    type: TypeKeys.FACE_RECOGNITION_FAILED,
    payload: { error }
  };
}

interface IFaceSavedAction {
  type: TypeKeys.FACE_SAVED;
}

function faceSaved(): IFaceSavedAction {
  return {
    type: TypeKeys.FACE_SAVED
  };
}
interface IFaceReappearedAction {
  type: TypeKeys.FACE_REAPPEARED;
}

function faceReappeared(): IFaceReappearedAction {
  return {
    type: TypeKeys.FACE_REAPPEARED
  };
}
interface IImageToBeBufferedAction {
  type: TypeKeys.IMAGE_RECEIVED_FOR_BUFFERING;
  payload: { image: string };
}

function bufferImage(image: string): IImageToBeBufferedAction {
  return {
    type: TypeKeys.IMAGE_RECEIVED_FOR_BUFFERING,
    payload: { image }
  };
}

/*
* Exported actions
*/
interface IToggleTrackingAction {
  type: TypeKeys.DEBUG_TOGGLE_TRACKING;
}

export function toggleTracking(): IToggleTrackingAction {
  return {
    type: TypeKeys.DEBUG_TOGGLE_TRACKING
  };
}

interface ISubmitFaceAction {
  type: TypeKeys.SUBMIT_FACE;
  payload: { name: string };
}
export const submitFace = (name: string) => {
  return {
    type: TypeKeys.SUBMIT_FACE,
    payload: { name }
  };
};

/*
 * State
 */
export interface IState {
  latestDetection: null | IDetection;
  currentlyRecognized: string[];
  currentNumberOfFaces: null | number;
  faceBuffer: string[];
  recognitionInProgress: boolean;
  shouldRecognizePeople: boolean;
  trackingStoppedForDebugging: boolean;
  firstFaceDetected: null | IFaceRect;
}

const initialState = {
  latestDetection: null,
  currentlyRecognized: [],
  currentNumberOfFaces: null,
  faceBuffer: [],
  recognitionInProgress: false,
  shouldRecognizePeople: true,
  trackingStoppedForDebugging: false,
  firstFaceDetected: null
};

function simpleDist(pointA: IFaceRect, pointB: IFaceRect) {
  const x = pointA.x - pointB.x;
  const y = pointA.y - pointB.y;

  return Math.sqrt(x * x + y * y);
}

function originalFaceStillInPicture(
  firstFaceDetected: null | IFaceRect,
  latestDetection: null | IDetection,
  detection: IDetection
) {
  if (!firstFaceDetected || !latestDetection || detection.amount === 0) {
    return false;
  }

  const sortedFaces = detection.data
    .slice(0)
    .sort(
      (a, b) =>
        simpleDist(a, firstFaceDetected) - simpleDist(b, firstFaceDetected)
    );
  const closest = sortedFaces[0];

  const likelyTheSame =
    Math.abs(firstFaceDetected.x - closest.x) < firstFaceDetected.width &&
    Math.abs(firstFaceDetected.y - closest.y) < firstFaceDetected.height;

  return likelyTheSame ? closest : false;
}

export function reducer(state: IState = initialState, action: Action) {
  const { latestDetection, faceBuffer } = state;
  switch (action.type) {
    case TypeKeys.IMAGE_RECEIVED_FOR_BUFFERING: {
      const { image } = action.payload;

      const newBuffer = faceBuffer.concat(image).slice(-FACE_BUFFER_SIZE);
      const newState = { ...state, faceBuffer: newBuffer };
      if (!newState.shouldRecognizePeople) {
        return newState;
      }

      if (newBuffer.length === FACE_BUFFER_SIZE) {
        const frame = getBestImageFromBuffer(newBuffer);

        return loop(
          {
            ...newState,
            recognitionInProgress: true
          },
          Cmd.run(recognize, {
            args: [frame],
            successActionCreator: facesRecognised,
            failActionCreator: faceRecognitionFailed
          })
        );
      }
      return newState;
    }
    case TypeKeys.FACES_DETECTED: {
      if (state.recognitionInProgress) {
        return state;
      }
      const { detection } = action.payload;

      const firstFaceInPicture = originalFaceStillInPicture(
        state.firstFaceDetected,
        latestDetection,
        detection
      );
      const amountChanged =
        !latestDetection || latestDetection.amount !== detection.amount;

      const shouldKeepBuffer =
        (!amountChanged && detection.amount === 1) || firstFaceInPicture;

      let newFirstFaceInPicture = null;

      if (firstFaceInPicture) {
        newFirstFaceInPicture = firstFaceInPicture;
      } else if (
        (!latestDetection || latestDetection.amount === 0) &&
        detection.amount === 1
      ) {
        newFirstFaceInPicture = detection.data[0];
      }

      const newState = {
        ...state,
        // Start recognizing people again when amount changes
        shouldRecognizePeople: state.shouldRecognizePeople
          ? state.shouldRecognizePeople
          : amountChanged,
        latestDetection: detection,
        firstFaceDetected: newFirstFaceInPicture,
        faceBuffer: !shouldKeepBuffer ? [] : state.faceBuffer
      };
      if (newFirstFaceInPicture) {
        return loop(
          newState,
          Cmd.run(crop, {
            args: [detection.image, newFirstFaceInPicture],
            successActionCreator: bufferImage
          })
        );
      }
      return newState;
    }

    case TypeKeys.FACE_RECOGNISED: {
      const existingFaces = action.payload.names.filter(
        name => state.currentlyRecognized.indexOf(name) > -1
      );

      const newState = {
        ...state,
        faceBuffer: action.payload.names.length > 0 ? [] : state.faceBuffer,
        currentlyRecognized: action.payload.names,
        shouldRecognizePeople: false,
        recognitionInProgress: false
      };

      if (existingFaces.length > 0) {
        return loop(newState, Cmd.action(faceReappeared()));
      }
      return newState;
    }
    case TypeKeys.FACE_RECOGNITION_FAILED:
      return { ...state, faceBuffer: [], recognitionInProgress: false };

    case TypeKeys.SUBMIT_FACE:
      return loop(
        state,
        Cmd.run(createModelForFace, {
          args: [action.payload.name, getBestImageFromBuffer(state.faceBuffer)],
          successActionCreator: faceSaved
        })
      );
    case TypeKeys.FACE_SAVED:
      return {
        ...state,
        faceBuffer: []
      };

    case TypeKeys.DEBUG_TOGGLE_TRACKING:
      return {
        ...state,
        trackingStoppedForDebugging: !state.trackingStoppedForDebugging
      };

    default:
      return state;
  }
}
