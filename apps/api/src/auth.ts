import { createRemoteJWKSet, jwtVerify } from "jose";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { prisma } from "./db.js";

const jwks = createRemoteJWKSet(new URL(config.OIDC_JWKS_URL));
const LOCAL_DEV_ACCESS_TOKEN = "local-dev-access-token";
const LOCAL_DEV_TECHNICIAN_ID = "local-dev-technician";
const LOCAL_DEV_ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";

function shouldAllowLocalBypass() {
  return config.ALLOW_LOCAL_DEV_BYPASS;
}

async function ensureLocalDevTechnician(): Promise<TechnicianIdentity> {
  const organization = await prisma.organization.upsert({
    where: { id: LOCAL_DEV_ORGANIZATION_ID },
    create: {
      id: LOCAL_DEV_ORGANIZATION_ID,
      name: "Local Development",
    },
    update: {},
  });

  const technician = await prisma.technician.upsert({
    where: { id: LOCAL_DEV_TECHNICIAN_ID },
    create: {
      id: LOCAL_DEV_TECHNICIAN_ID,
      organizationId: organization.id,
      displayName: "Local Technician",
      role: "technician",
    },
    update: {
      organizationId: organization.id,
      displayName: "Local Technician",
      role: "technician",
    },
  });

  return {
    id: technician.id,
    organizationId: technician.organizationId,
    displayName: technician.displayName,
    role: technician.role,
  };
}

export interface TechnicianIdentity {
  id: string;
  organizationId: string;
  displayName: string;
  role: string;
}

export interface VerifiedTechnicianAccessToken {
  subject: string;
  expiresAt: number;
}

export async function verifyTechnicianAccessToken(
  accessToken: string,
): Promise<VerifiedTechnicianAccessToken | null> {
  if (shouldAllowLocalBypass() && accessToken === LOCAL_DEV_ACCESS_TOKEN) {
    return {
      subject: LOCAL_DEV_TECHNICIAN_ID,
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
  }

  try {
    const { payload } = await jwtVerify(accessToken, jwks, {
      issuer: config.OIDC_ISSUER,
      audience: config.OIDC_AUDIENCE,
    });
    return typeof payload.sub === "string" && typeof payload.exp === "number"
      ? { subject: payload.sub, expiresAt: payload.exp }
      : null;
  } catch {
    return null;
  }
}

declare global {
  namespace Express {
    interface Request {
      technician?: TechnicianIdentity;
    }
  }
}

export async function requireTechnician(req: Request, res: Response, next: NextFunction) {
  const authorization = req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const verified = await verifyTechnicianAccessToken(authorization.slice("Bearer ".length));
  if (!verified) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  let technician = await prisma.technician.findUnique({
    where: { id: verified.subject },
    select: { id: true, organizationId: true, displayName: true, role: true },
  });

  if (shouldAllowLocalBypass() && verified.subject === LOCAL_DEV_TECHNICIAN_ID && !technician) {
    technician = await ensureLocalDevTechnician();
  }

  if (!technician) {
    res.status(403).json({ error: "technician_not_provisioned" });
    return;
  }
  if (technician.role !== "technician" && technician.role !== "admin") {
    res.status(403).json({ error: "insufficient_role" });
    return;
  }

  req.technician = technician;
  next();
}
