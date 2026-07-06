import { APIData, APIMethod } from '../api-handler';

/** Read-only entity-code registry (lookup-entity-prd.md §7). Drives the
 *  permission-matrix's rows — mirrors `apps/backend/src/entity-types/entity-types.controller.ts`. */
export const GET_ENTITY_TYPES = new APIData('entity-types', APIMethod.GET);
