import { describe, it, expect } from 'vitest';
import { ConfidenceScorer, type UserProfile } from '../scorer.js';

const SENIOR_SWE_PROFILE: UserProfile = {
  skills: [
    'typescript', 'javascript', 'python', 'react', 'node.js',
    'postgresql', 'redis', 'docker', 'kubernetes', 'aws',
    'rest', 'graphql', 'git', 'agile', 'system design',
    'microservices', 'ci/cd', 'distributed systems',
  ],
  experienceYears: 6,
  level: 'senior',
  domains: ['backend', 'full-stack'],
};

const SWE_JD = `
Senior Software Engineer - Backend

We are looking for a Senior Software Engineer to join our Platform team.

Requirements:
- 5+ years of experience in software development
- Strong proficiency in TypeScript and Node.js
- Experience with PostgreSQL and Redis
- Experience building REST APIs and microservices
- Familiarity with Docker, Kubernetes, and AWS
- Strong system design skills
- Experience with CI/CD pipelines and Agile methodologies
- Excellent communication and leadership skills

Nice to have:
- Experience with GraphQL
- Knowledge of distributed systems
`;

const NON_TECH_JD = `
Senior Financial Auditor

We are seeking a Senior Financial Auditor to join our internal audit team.

Requirements:
- CPA certification required
- 5+ years of auditing experience
- Strong knowledge of GAAP and IFRS
- Experience with SAP and Excel
- Excellent analytical and communication skills
`;

const DATA_ENGINEER_JD = `
Data Engineer

Join our data engineering team to build scalable data pipelines.

Requirements:
- 3+ years of experience as a data engineer
- Strong Python and SQL skills
- Experience with Spark, Kafka, and Airflow
- AWS or GCP experience
- Knowledge of ETL processes and data modeling
`;

describe('ConfidenceScorer', () => {
  const scorer = new ConfidenceScorer();

  describe('extractKeywords', () => {
    it('extracts programming languages', () => {
      const keywords = scorer.extractKeywords('We need Python and TypeScript experience');
      expect(keywords).toContain('python');
      expect(keywords).toContain('typescript');
    });

    it('extracts frameworks', () => {
      const keywords = scorer.extractKeywords('Must know React, Node.js, and Django');
      expect(keywords).toContain('react');
      expect(keywords).toContain('node.js');
      expect(keywords).toContain('django');
    });

    it('extracts cloud platforms', () => {
      const keywords = scorer.extractKeywords('Deploy to AWS with Docker and Kubernetes');
      expect(keywords).toContain('aws');
      expect(keywords).toContain('docker');
      expect(keywords).toContain('kubernetes');
    });

    it('extracts databases', () => {
      const keywords = scorer.extractKeywords('Work with PostgreSQL and Redis');
      expect(keywords).toContain('postgresql');
      expect(keywords).toContain('redis');
    });

    it('returns sorted, deduplicated list', () => {
      const keywords = scorer.extractKeywords('Python, python, PYTHON');
      const pythonCount = keywords.filter(k => k === 'python').length;
      expect(pythonCount).toBe(1);
      expect(keywords).toEqual([...keywords].sort());
    });
  });

  describe('score - domain gate', () => {
    it('returns 0 for non-programming roles', () => {
      const result = scorer.score(NON_TECH_JD, SENIOR_SWE_PROFILE);
      expect(result.overall).toBe(0);
      expect(result.isProgrammingRole).toBe(false);
      expect(result.recommendation).toBe('skip');
    });

    it('identifies software engineering roles', () => {
      const result = scorer.score(SWE_JD, SENIOR_SWE_PROFILE);
      expect(result.isProgrammingRole).toBe(true);
      expect(result.detectedDomain).toBe('software_engineering');
    });

    it('identifies adjacent technical roles', () => {
      const result = scorer.score(DATA_ENGINEER_JD, SENIOR_SWE_PROFILE);
      expect(result.isProgrammingRole).toBe(true);
      expect(result.detectedDomain).toBe('adjacent_technical');
    });
  });

  describe('score - strong match', () => {
    it('scores a strong match for well-aligned SWE role', () => {
      const result = scorer.score(SWE_JD, SENIOR_SWE_PROFILE);
      expect(result.overall).toBeGreaterThanOrEqual(70);
      expect(result.recommendation).not.toBe('skip');
      expect(result.matchedSkills.length).toBeGreaterThan(0);
    });

    it('returns matched and missing skills', () => {
      const result = scorer.score(SWE_JD, SENIOR_SWE_PROFILE);
      expect(result.matchedSkills).toContain('typescript');
      expect(result.matchedSkills).toContain('node.js');
    });
  });

  describe('score - level detection', () => {
    it('detects senior level', () => {
      const result = scorer.score(SWE_JD, SENIOR_SWE_PROFILE);
      expect(result.detectedLevel).toBe('senior');
    });

    it('scores well when level matches', () => {
      const result = scorer.score(SWE_JD, SENIOR_SWE_PROFILE);
      expect(result.breakdown.levelMatch).toBeGreaterThanOrEqual(70);
    });

    it('scores lower for level mismatch', () => {
      const juniorProfile: UserProfile = { ...SENIOR_SWE_PROFILE, level: 'junior' };
      const result = scorer.score(SWE_JD, juniorProfile);
      expect(result.breakdown.levelMatch).toBeLessThan(70);
    });
  });

  describe('score - experience years', () => {
    it('detects years requirement', () => {
      const result = scorer.score(SWE_JD, SENIOR_SWE_PROFILE);
      expect(result.detectedYears).toBe(5);
    });

    it('scores well when experience exceeds requirement', () => {
      const result = scorer.score(SWE_JD, SENIOR_SWE_PROFILE);
      expect(result.breakdown.experienceYears).toBe(100);
    });

    it('scores lower when experience falls short', () => {
      const juniorProfile: UserProfile = { ...SENIOR_SWE_PROFILE, experienceYears: 2 };
      const result = scorer.score(SWE_JD, juniorProfile);
      expect(result.breakdown.experienceYears).toBeLessThan(100);
    });
  });

  describe('score - recommendation tiers', () => {
    it('returns correct tier labels', () => {
      const strongResult = scorer.score(SWE_JD, SENIOR_SWE_PROFILE);
      expect(['strong_match', 'moderate_match']).toContain(strongResult.recommendation);

      const weakProfile: UserProfile = {
        skills: ['cobol'],
        experienceYears: 1,
        level: 'junior',
        domains: ['mainframe'],
      };
      const weakResult = scorer.score(SWE_JD, weakProfile);
      expect(['weak_match', 'skip']).toContain(weakResult.recommendation);
    });
  });

  describe('score - partial skill match', () => {
    it('scores moderately with partial skill overlap', () => {
      const partialProfile: UserProfile = {
        skills: ['typescript', 'python', 'git'],
        experienceYears: 5,
        level: 'senior',
        domains: ['backend'],
      };
      const result = scorer.score(SWE_JD, partialProfile);
      expect(result.overall).toBeGreaterThan(30);
      expect(result.overall).toBeLessThan(90);
      expect(result.missingSkills.length).toBeGreaterThan(0);
    });
  });
});
