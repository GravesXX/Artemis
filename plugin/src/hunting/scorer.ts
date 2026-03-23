// ── Interfaces ──────────────────────────────────────────────────────────────

export interface UserProfile {
  skills: string[];
  experienceYears: number;
  level: string;
  domains: string[];
}

export interface ScoreBreakdown {
  skillsMatch: number;
  levelMatch: number;
  domainRelevance: number;
  experienceYears: number;
}

export interface ScoreResult {
  overall: number;
  breakdown: ScoreBreakdown;
  matchedSkills: string[];
  missingSkills: string[];
  detectedLevel: string | null;
  detectedYears: number | null;
  detectedDomain: string;
  isProgrammingRole: boolean;
  recommendation: 'strong_match' | 'moderate_match' | 'weak_match' | 'skip';
}

// ── Level hierarchy ─────────────────────────────────────────────────────────

const LEVEL_ORDER = ['junior', 'mid', 'senior', 'lead', 'staff', 'principal'] as const;

// ── ConfidenceScorer ────────────────────────────────────────────────────────

export class ConfidenceScorer {

  score(jobText: string, profile: UserProfile): ScoreResult {
    // Domain gate — non-programming roles get 0
    const domainResult = this.scoreDomain(jobText);
    if (!domainResult.isProgrammingRole) {
      return {
        overall: 0,
        breakdown: { skillsMatch: 0, levelMatch: 0, domainRelevance: 0, experienceYears: 0 },
        matchedSkills: [],
        missingSkills: [],
        detectedLevel: this.detectLevel(jobText),
        detectedYears: this.extractYearsRequirement(jobText),
        detectedDomain: domainResult.detectedDomain,
        isProgrammingRole: false,
        recommendation: 'skip',
      };
    }

    const jdKeywords = this.extractKeywords(jobText);
    const skillsResult = this.scoreSkills(jdKeywords, profile.skills);
    const levelResult = this.scoreLevel(jobText, profile.level);
    const expResult = this.scoreExperience(jobText, profile.experienceYears);

    const breakdown: ScoreBreakdown = {
      skillsMatch: skillsResult.score,
      levelMatch: levelResult.score,
      domainRelevance: domainResult.score,
      experienceYears: expResult.score,
    };

    const overall = Math.round(
      breakdown.skillsMatch * 0.4 +
      breakdown.levelMatch * 0.25 +
      breakdown.domainRelevance * 0.2 +
      breakdown.experienceYears * 0.15
    );

    return {
      overall,
      breakdown,
      matchedSkills: skillsResult.matched,
      missingSkills: skillsResult.missing,
      detectedLevel: levelResult.detectedLevel,
      detectedYears: expResult.detectedYears,
      detectedDomain: domainResult.detectedDomain,
      isProgrammingRole: true,
      recommendation: this.tierFromScore(overall),
    };
  }

  // ── Sub-scorers ─────────────────────────────────────────────────────────

  private scoreSkills(jdKeywords: string[], profileSkills: string[]): {
    score: number;
    matched: string[];
    missing: string[];
  } {
    if (jdKeywords.length === 0) {
      return { score: 80, matched: [], missing: [] };
    }

    const profileSet = new Set(profileSkills.map(s => s.toLowerCase()));
    const matched: string[] = [];
    const missing: string[] = [];

    for (const keyword of jdKeywords) {
      if (profileSet.has(keyword)) {
        matched.push(keyword);
      } else {
        missing.push(keyword);
      }
    }

    const score = Math.min(100, Math.round((matched.length / jdKeywords.length) * 100));
    return { score, matched, missing };
  }

  private scoreLevel(jobText: string, profileLevel: string): {
    score: number;
    detectedLevel: string | null;
  } {
    const detectedLevel = this.detectLevel(jobText);
    if (!detectedLevel) {
      return { score: 70, detectedLevel: null };
    }

    const profileIdx = LEVEL_ORDER.indexOf(profileLevel as typeof LEVEL_ORDER[number]);
    const jobIdx = LEVEL_ORDER.indexOf(detectedLevel as typeof LEVEL_ORDER[number]);

    if (profileIdx < 0 || jobIdx < 0) {
      return { score: 70, detectedLevel };
    }

    const diff = Math.abs(profileIdx - jobIdx);
    if (diff === 0) return { score: 100, detectedLevel };
    if (diff === 1) return { score: 70, detectedLevel };
    return { score: 30, detectedLevel };
  }

  private scoreDomain(jobText: string): {
    score: number;
    detectedDomain: string;
    isProgrammingRole: boolean;
  } {
    const domain = this.classifyDomain(jobText);

    switch (domain) {
      case 'software_engineering':
        return { score: 100, detectedDomain: domain, isProgrammingRole: true };
      case 'adjacent_technical':
        return { score: 80, detectedDomain: domain, isProgrammingRole: true };
      case 'tangential':
        return { score: 40, detectedDomain: domain, isProgrammingRole: false };
      default:
        return { score: 0, detectedDomain: domain, isProgrammingRole: false };
    }
  }

  private scoreExperience(jobText: string, profileYears: number): {
    score: number;
    detectedYears: number | null;
  } {
    const detectedYears = this.extractYearsRequirement(jobText);
    if (detectedYears === null) {
      return { score: 80, detectedYears: null };
    }

    const diff = profileYears - detectedYears;
    if (diff >= 0) return { score: 100, detectedYears };
    if (diff >= -2) return { score: 60, detectedYears };
    return { score: 20, detectedYears };
  }

  // ── Keyword extraction (adapted from Athena's tailor.ts) ────────────────

  extractKeywords(text: string): string[] {
    const techTerms = new Set<string>();

    const patterns = [
      // Programming languages
      /\b(python|java|javascript|typescript|c\+\+|c#|go|golang|rust|ruby|php|swift|kotlin|scala|r)\b/gi,
      // Frameworks and libraries
      /\b(react|angular|vue|next\.?js|node\.?js|express|django|flask|spring|\.net|rails|laravel|fastapi)\b/gi,
      // Cloud and infrastructure
      /\b(aws|azure|gcp|google cloud|docker|kubernetes|k8s|terraform|ansible|jenkins|ci\/cd|github actions)\b/gi,
      // Databases
      /\b(sql|mysql|postgresql|postgres|mongodb|redis|dynamodb|elasticsearch|cassandra|sqlite|oracle)\b/gi,
      // Tools and practices
      /\b(git|jira|confluence|agile|scrum|kanban|tdd|devops|microservices|rest|graphql|grpc|api)\b/gi,
      // Data and ML
      /\b(machine learning|ml|ai|data engineering|etl|spark|kafka|airflow|pandas|tensorflow|pytorch)\b/gi,
      // Concepts
      /\b(distributed systems|system design|scalab\w+|high availability|load balancing|caching|monitoring|observability)\b/gi,
      // Soft skills and requirements
      /\b(leadership|mentoring|cross-functional|stakeholder|communication)\b/gi,
    ];

    for (const pattern of patterns) {
      const matches = text.match(pattern);
      if (matches) {
        for (const m of matches) {
          techTerms.add(m.toLowerCase().trim());
        }
      }
    }

    return [...techTerms].sort();
  }

  // ── Utility methods ─────────────────────────────────────────────────────

  private extractYearsRequirement(text: string): number | null {
    const patterns = [
      /(\d+)\+?\s*(?:years?|yrs?)\s*(?:of\s+)?(?:experience|professional)/i,
      /(\d+)\s*-\s*\d+\s*(?:years?|yrs?)/i,
      /minimum\s+(\d+)\s*(?:years?|yrs?)/i,
      /at\s+least\s+(\d+)\s*(?:years?|yrs?)/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        return parseInt(match[1], 10);
      }
    }
    return null;
  }

  private detectLevel(text: string): string | null {
    const levelSignals: Array<[string, RegExp]> = [
      ['principal', /\bprincipal\b/i],
      ['staff', /\bstaff\b/i],
      ['lead', /\blead\s+(?:engineer|developer|swe)\b/i],
      ['senior', /\bsenior\b|\bsr\.?\s/i],
      ['mid', /\bmid[\s-]?level\b/i],
      ['junior', /\bjunior\b|\bjr\.?\s|\bentry[\s-]?level\b|\bnew\s+grad\b/i],
    ];

    for (const [level, pattern] of levelSignals) {
      if (pattern.test(text)) return level;
    }
    return null;
  }

  private classifyDomain(text: string): string {
    const lower = text.toLowerCase();

    const programmingSignals = [
      'software engineer', 'developer', 'programmer', 'full-stack',
      'fullstack', 'backend', 'frontend', 'full stack', 'swe',
      'platform engineer', 'infrastructure engineer', 'sre',
      'site reliability', 'devops engineer', 'systems engineer',
      'build', 'deploy', 'api', 'codebase', 'architecture',
      'microservices', 'distributed systems',
    ];

    const adjacentSignals = [
      'data engineer', 'ml engineer', 'machine learning engineer',
      'data scientist', 'ai engineer', 'mlops',
    ];

    const programmingCount = programmingSignals.filter(s => lower.includes(s)).length;
    const adjacentCount = adjacentSignals.filter(s => lower.includes(s)).length;

    if (programmingCount >= 2) return 'software_engineering';
    if (adjacentCount >= 1) return 'adjacent_technical';
    if (programmingCount >= 1) return 'software_engineering';
    return 'non_technical';
  }

  private tierFromScore(score: number): ScoreResult['recommendation'] {
    if (score >= 80) return 'strong_match';
    if (score >= 60) return 'moderate_match';
    if (score >= 40) return 'weak_match';
    return 'skip';
  }
}
