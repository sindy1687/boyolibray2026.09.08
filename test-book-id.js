// 測試書籍編號生成邏輯
console.log('=== 測試書籍編號生成邏輯 ===');

// 模擬 LibrarySystem 類別的關鍵部分
class TestLibrarySystem {
    constructor() {
        // 設定測試書籍數據
        this.books = [
            // C 區書籍：有 C0001, C0002, C0005, C0566 (缺少 C0003, C0004)
            { id: 'C0001', title: '測試書籍 1' },
            { id: 'C0002', title: '測試書籍 2' },
            { id: 'C0005', title: '測試書籍 5' },
            { id: 'C0566', title: '測試書籍 566' },
            
            // A 區書籍：有 A0001, A0003 (缺少 A0002)
            { id: 'A0001', title: '繪本測試 1' },
            { id: 'A0003', title: '繪本測試 3' },
            
            // B 區書籍：有 B0001, B0002, B0004 (缺少 B0003)
            { id: 'B0001', title: '橋梁書測試 1' },
            { id: 'B0002', title: '橋梁書測試 2' },
            { id: 'B0004', title: '橋梁書測試 4' }
        ];
    }

    generateNextBookId(prefix) {
        const used = new Set();
        const existingNumbers = [];

        // 收集所有已使用的編號
        this.books.forEach(book => {
            if (book?.id) {
                const idStr = String(book.id).toUpperCase();
                if (idStr.startsWith(prefix)) {
                    const numPart = idStr.substring(prefix.length);
                    const num = parseInt(numPart, 10);
                    if (!isNaN(num)) {
                        used.add(idStr);
                        existingNumbers.push(num);
                    }
                }
            }
            if (Array.isArray(book?.bookIds)) {
                book.bookIds.forEach(id => {
                    if (id) {
                        const idStr = String(id).toUpperCase();
                        if (idStr.startsWith(prefix)) {
                            const numPart = idStr.substring(prefix.length);
                            const num = parseInt(numPart, 10);
                            if (!isNaN(num)) {
                                used.add(idStr);
                                existingNumbers.push(num);
                            }
                        }
                    }
                });
            }
        });

        // 如果沒有任何書籍，從 C0001 開始
        if (existingNumbers.length === 0) {
            return `${prefix}0001`;
        }

        // 找出最大編號
        const maxNumber = Math.max(...existingNumbers);
        
        // 生成所有可能的編號（從1到最大編號+1）
        for (let i = 1; i <= maxNumber + 1; i++) {
            const candidate = `${prefix}${String(i).padStart(4, '0')}`;
            if (!used.has(candidate)) {
                return candidate;
            }
        }

        // 如果都找不到，返回最大編號+1
        return `${prefix}${String(maxNumber + 1).padStart(4, '0')}`;
    }
}

// 執行測試
const library = new TestLibrarySystem();

const testCases = [
    { prefix: 'C', expected: 'C0003', description: 'C區：應該返回 C0003 (缺少 C0003, C0004)' },
    { prefix: 'A', expected: 'A0002', description: 'A區：應該返回 A0002 (缺少 A0002)' },
    { prefix: 'B', expected: 'B0003', description: 'B區：應該返回 B0003 (缺少 B0003)' },
    { prefix: 'D', expected: 'D0001', description: 'D區：沒有書籍，應該返回 D0001' }
];

testCases.forEach(testCase => {
    const result = library.generateNextBookId(testCase.prefix);
    const passed = result === testCase.expected;
    
    console.log(`\n${testCase.description}`);
    console.log(`預期: ${testCase.expected}`);
    console.log(`實際: ${result}`);
    console.log(`結果: ${passed ? '✓ 通過' : '✗ 失敗'}`);
});

console.log('\n=== 測試完成 ===');
