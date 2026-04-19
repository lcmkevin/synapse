import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { LicenseManager } from '../../license';

export interface ConversionResult {
    originalRule: string;
    skillName: string;
    tokensSaved: number;
    success: boolean;
    error?: string;
}

export class SkillConverter {
    private isProUser: boolean = false;
    
    constructor(private context: vscode.ExtensionContext) {
        this.isProUser = LicenseManager.getInstance().isProUser();
    }
    
    // Extract constraints from rule content
    private extractConstraints(content: string): string[] {
        const constraints: string[] = [];
        const lines = content.split('\n');
        let inConstraints = false;
        
        for (const line of lines) {
            if (line.includes('# Constraints:')) {
                inConstraints = true;
                continue;
            }
            if (inConstraints && line.includes('# @constraint')) {
                constraints.push(line.replace('# @constraint', '').trim());
            }
            if (inConstraints && !line.startsWith('#') && line.trim() !== '') {
                inConstraints = false;
            }
        }
        return constraints;
    }
    
    // Extract description from rule
    private extractDescription(content: string): string | null {
        const match = content.match(/# Description:\s*(.+)/);
        return match ? match[1] : null;
    }
    
    // Create stub rule that preserves constraints
    private createStubRule(ruleName: string, skillName: string, constraints: string[], description: string | null): string {
        const lines: string[] = [];
        
        // Header
        lines.push(`# Rule: ${ruleName} (Lazy-Loaded Stub)`);
        
        // Preserve description
        if (description) {
            lines.push(`# Description: ${description} (converted to skill: ${skillName})`);
        } else {
            lines.push(`# Description: Lazy-loaded stub (skill: ${skillName})`);
        }
        
        // Status marker
        lines.push(`# Status: lazy-stub`);
        lines.push(`# @lazy true`);
        lines.push(`# @skill ${skillName}`);
        lines.push('');
        
        // Preserve constraints
        if (constraints.length > 0) {
            lines.push('# Constraints:');
            for (const constraint of constraints) {
                lines.push(`# @constraint ${constraint}`);
            }
            lines.push('');
        }
        
        // Helpful note
        lines.push('# ----- Original content moved to skill -----');
        lines.push(`# Full rule content: .synapse/skills/${skillName}.skill`);
        lines.push('# The skill loads automatically when constraints match.');
        lines.push('# To restore: delete this stub and move the skill file back to rules/');
        
        return lines.join('\n');
    }
    
    // Create skill file with full content
    private createSkillFile(content: string, ruleName: string): string {
        // Remove constraint lines from skill content (they stay in stub)
        const cleanContent = content.split('\n')
            .filter(line => !line.includes('# Constraints:'))
            .filter(line => !line.includes('# @constraint'))
            .join('\n');
        
        return `# Skill: ${ruleName}
# Description: Auto-converted from rule ${ruleName}
# Type: lazy-loaded
# Trigger: Loads when context matches stub constraints

${cleanContent}

# Usage: This skill loads only when needed, saving tokens
# Original rule: ${ruleName}
`;
    }
    
    async convertToSkill(
        rulePath: string,
        ruleContent: string,
        tokenCount: number,
        options: { keepOriginal?: boolean; stubOriginal?: boolean } = {}
    ): Promise<ConversionResult> {
        const ruleName = path.basename(rulePath, '.synapse');
        const skillName = `${ruleName}-skill`;
        
        const license = LicenseManager.getInstance();
        if (!license.canUseFeature('autoConvert')) {
            await license.showUpgradePrompt();
            throw new Error('Pro feature. Upgrade to convert rules to skills.');
        }
        
        try {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) throw new Error('No workspace');
            
            // Extract metadata for stub preservation
            const constraints = this.extractConstraints(ruleContent);
            const description = this.extractDescription(ruleContent);
            
            // Create skill file
            const skillsPath = path.join(workspaceRoot, '.synapse', 'skills');
            await fs.mkdir(skillsPath, { recursive: true });
            
            const skillContent = this.createSkillFile(ruleContent, ruleName);
            await fs.writeFile(path.join(skillsPath, `${skillName}.skill`), skillContent);
            
            // Modify original rule to stub (preserve constraints)
            if (options.stubOriginal) {
                const stubContent = this.createStubRule(ruleName, skillName, constraints, description);
                await fs.writeFile(rulePath, stubContent);
            } else if (!options.keepOriginal) {
                await fs.unlink(rulePath);
            }
            
            // Calculate tokens saved (70% savings estimate)
            const tokensSaved = Math.floor(tokenCount * 0.7);
            
            return {
                originalRule: ruleName,
                skillName,
                tokensSaved,
                success: true,
            };
        } catch (error) {
            return {
                originalRule: ruleName,
                skillName,
                tokensSaved: 0,
                success: false,
                error: String(error),
            };
        }
    }
    
    async batchConvert(rules: { path: string; content: string; tokens: number }[]): Promise<ConversionResult[]> {
        const results: ConversionResult[] = [];
        for (const rule of rules) {
            const result = await this.convertToSkill(rule.path, rule.content, rule.tokens, { stubOriginal: true });
            results.push(result);
        }
        return results;
    }
    
    async upgradeToPro() {
        this.isProUser = true;
        await this.context.globalState.update('synapsePro', true);
        vscode.window.showInformationMessage('🎉 Synapse Pro activated! Token optimization features unlocked.');
    }
}
