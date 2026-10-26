import type { PublicUser } from '../auth/public-user';
import type { Document } from '../collab/ops';
import type { RoomManager } from '../collab/rooms';
import { hashDocument } from './document-index';

export type ProjectReadSnapshot = {
  doc: Document;
  version: number;
  epoch: number;
  baseHash: string;
};

export type CommitProposalInput = {
  projectId: string;
  proposalId: string;
  revision: number;
  user: PublicUser;
};

export type CommitProposalResult = {
  proposalId: string;
  revision: number;
  version: number;
  snapshotId: string | null;
  applied: true;
};

export interface AiRooms {
  read(projectId: string): Promise<ProjectReadSnapshot>;
  commitProposal?(input: CommitProposalInput): Promise<CommitProposalResult>;
}

export function createProjectSource(
  rooms: Pick<RoomManager, 'join'> & {
    commitProposal?: (input: CommitProposalInput) => Promise<CommitProposalResult>;
  },
): AiRooms {
  return {
    async read(projectId: string): Promise<ProjectReadSnapshot> {
      const joined = await rooms.join(projectId);
      const doc = joined.doc;
      const baseHash = hashDocument(doc);
      return {
        doc,
        version: joined.version,
        epoch: joined.epoch,
        baseHash,
      };
    },
    ...(typeof rooms.commitProposal === 'function'
      ? {
          commitProposal: (input: CommitProposalInput) => rooms.commitProposal!(input),
        }
      : {}),
  };
}

