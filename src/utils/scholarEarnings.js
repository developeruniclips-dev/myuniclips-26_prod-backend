// Report from recorded payments, never from a course's current price.
// The tier is lifetime sales per course, including sales before the current month.
function calculateScholarEarnings(sales, courses = []) {
    const currencies = new Set(sales.map(s => String(s.currency || 'EUR').toUpperCase()));
    if (currencies.size > 1) throw new Error('Currency-separated earnings required');
    const byCourse = new Map(courses.map(course => [Number(course.id), {
        id: Number(course.id), courseName: course.name, bundlePrice: Number(course.bundle_price || 0).toFixed(2),
        salesCount: 0, revenue: 0, scholarEarnings: 0, monthlySales: 0, monthlyRevenue: 0, monthlyEarnings: 0
    }]));
    let videoSales = 0, bundleSales = 0;
    for (const sale of sales) {
        const id = Number(sale.subject_id);
        if (!byCourse.has(id)) byCourse.set(id, { id, courseName: sale.course_name || `Course #${id}`,
            bundlePrice: null, salesCount: 0, revenue: 0, scholarEarnings: 0, monthlySales: 0, monthlyRevenue: 0, monthlyEarnings: 0 });
        const course = byCourse.get(id);
        const cents = Math.round(Number(sale.amount) * 100);
        const earned = sale.scholar_minor != null ? Number(sale.scholar_minor) : cents * (course.salesCount < 100 ? 0.7 : 0.5);
        course.salesCount++;
        course.revenue += cents;
        course.scholarEarnings += earned;
        if (Number(sale.is_current_month)) {
            course.monthlySales++;
            course.monthlyRevenue += cents;
            course.monthlyEarnings += earned;
        }
        if (sale.kind === 'video') videoSales++; else bundleSales++;
    }
    const totals = [...byCourse.values()].reduce((sum, course) => {
        for (const key of ['salesCount', 'revenue', 'scholarEarnings', 'monthlySales', 'monthlyRevenue', 'monthlyEarnings']) sum[key] = (sum[key] || 0) + course[key];
        return sum;
    }, { salesCount: 0, revenue: 0, scholarEarnings: 0, monthlySales: 0, monthlyRevenue: 0, monthlyEarnings: 0 });
    const format = cents => (cents / 100).toFixed(2);
    return {
        summary: { totalSales: totals.salesCount, totalRevenue: format(totals.revenue), scholarEarnings: format(totals.scholarEarnings),
            platformFee: format(totals.revenue - totals.scholarEarnings), monthlySales: totals.monthlySales,
            monthlyRevenue: format(totals.monthlyRevenue), monthlyEarnings: format(totals.monthlyEarnings), videoSales, bundleSales },
        salesByCourse: [...byCourse.values()].map(course => ({ ...course, revenue: format(course.revenue), scholarEarnings: format(course.scholarEarnings),
            monthlyRevenue: format(course.monthlyRevenue), monthlyEarnings: format(course.monthlyEarnings) }))
    };
}
module.exports = { calculateScholarEarnings };
